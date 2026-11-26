/**
 * Anti-flicker terminal output coalescer supporting:
 * 1. DEC Mode 2026 Synchronized Output (`\x1b[?2026h` ... `\x1b[?2026l`) — holds partial TUI frames
 *    until the closing marker arrives (with a 60ms safety watchdog so output never stalls).
 * 2. Erase + cursor-hide redraw coalescing (`\x1b[?25l` combined with screen/line erase sequences) —
 *    catches mid-frame blank flashes from older tmux (e.g. tmux 2.8) and Ink/TUI apps with a short
 *    14ms hold window while NEVER delaying plain interactive typing or cursor movement!
 * 3. VSync frame batching — coalesces fragmented SSH TCP packets within a single paint frame into
 *    one `term.write()` call.
 */

const BSU = '\x1b[?2026h'
const ESU = '\x1b[?2026l'
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'
// Matches ANSI clear-line / clear-screen / cursor-home sequences typical of TUI full-frame redraws
const ERASE_OR_HOME_RE = /\x1b\[(?:[012]?[KJ]|1;1H|H)/

const MAX_BUFFER_BYTES = 256 * 1024
const SYNC_MAX_HOLD_MS = 60
const CURSOR_HIDE_HOLD_MS = 14

export interface FrameBufferScheduler {
  scheduleFrame: (cb: () => void) => () => void
  scheduleTimeout: (cb: () => void, ms: number) => () => void
}

function defaultScheduler(): FrameBufferScheduler {
  const g = globalThis as unknown as {
    requestAnimationFrame?: (cb: () => void) => number
    cancelAnimationFrame?: (id: number) => void
  }
  const reqRaf = typeof g.requestAnimationFrame === 'function' ? g.requestAnimationFrame.bind(g) : null
  const canRaf = typeof g.cancelAnimationFrame === 'function' ? g.cancelAnimationFrame.bind(g) : null
  return {
    scheduleFrame: (cb) => {
      let done = false
      const run = () => {
        if (done) return
        done = true
        if (rafId !== null && canRaf) canRaf(rafId)
        clearTimeout(fallbackId)
        cb()
      }
      // Align with VSync when visible, with a 36ms fallback if the window/tab is backgrounded
      const rafId = reqRaf ? reqRaf(run) : null
      const fallbackId = setTimeout(run, 36)
      return () => {
        done = true
        if (rafId !== null && canRaf) canRaf(rafId)
        clearTimeout(fallbackId)
      }
    },
    scheduleTimeout: (cb, ms) => {
      const id = setTimeout(cb, ms)
      return () => clearTimeout(id)
    }
  }
}

/**
 * Checks whether `str` ends with a non-empty strict prefix of `\x1b[?2026h` or `\x1b[?2026l`
 * so a DEC 2026 marker split across two SSH chunks is never missed.
 */
function findPartialDec2026TailLength(str: string): number {
  const maxCheck = Math.min(str.length, BSU.length - 1)
  for (let len = maxCheck; len >= 3; len--) {
    const tail = str.slice(str.length - len)
    if (BSU.startsWith(tail) || ESU.startsWith(tail)) {
      return len
    }
  }
  return 0
}

export class TerminalFrameBuffer {
  private pending = ''
  private partialEsc = ''
  private inSyncUpdate = false
  private cursorHiddenInPending = false
  private hasEraseInPending = false
  private cancelFrame: (() => void) | null = null
  private cancelWatchdog: (() => void) | null = null
  private disposed = false
  private scheduler: FrameBufferScheduler

  constructor(
    private onFlush: (batch: string) => void,
    scheduler?: FrameBufferScheduler
  ) {
    this.scheduler = scheduler ?? defaultScheduler()
  }

  push(rawChunk: string): void {
    if (this.disposed || !rawChunk) return

    const combined = this.partialEsc + rawChunk
    this.partialEsc = ''

    // Carry over a partial `\x1b[?2026` tail across TCP packet boundaries
    const partialLen = findPartialDec2026TailLength(combined)
    let text = combined
    if (partialLen > 0) {
      this.partialEsc = combined.slice(combined.length - partialLen)
      text = combined.slice(0, combined.length - partialLen)
    }

    // Parse DEC Mode 2026 markers in order while stripping them from the emitted stream
    let pos = 0
    while (pos < text.length) {
      const nextBsu = text.indexOf(BSU, pos)
      const nextEsu = text.indexOf(ESU, pos)

      let nextIdx = -1
      let isBsu = false
      if (nextBsu >= 0 && (nextEsu < 0 || nextBsu < nextEsu)) {
        nextIdx = nextBsu
        isBsu = true
      } else if (nextEsu >= 0) {
        nextIdx = nextEsu
        isBsu = false
      }

      if (nextIdx < 0) {
        this.appendSegment(text.slice(pos))
        break
      }

      if (nextIdx > pos) {
        this.appendSegment(text.slice(pos, nextIdx))
      }

      if (isBsu) {
        this.inSyncUpdate = true
      } else {
        this.inSyncUpdate = false
      }
      pos = nextIdx + (isBsu ? BSU.length : ESU.length)
    }

    // Guard against huge streaming logs (e.g. `cat huge.log`) hoarding memory
    if (this.pending.length >= MAX_BUFFER_BYTES) {
      this.flushNow()
      return
    }

    if (!this.pending) return

    if (this.inSyncUpdate) {
      // Hold until ESU (`\x1b[?2026l`) arrives, bounded by 60ms watchdog
      this.clearFrameSchedule()
      if (!this.cancelWatchdog) {
        this.cancelWatchdog = this.scheduler.scheduleTimeout(() => {
          this.inSyncUpdate = false
          this.flushNow()
        }, SYNC_MAX_HOLD_MS)
      }
      return
    }

    // Only apply the brief cursor-hide hold when an erase/home sequence is also pending
    // (genuine mid-frame screen redraw), so interactive keystrokes & cursor updates flush immediately!
    if (this.cursorHiddenInPending && this.hasEraseInPending) {
      this.clearFrameSchedule()
      if (!this.cancelWatchdog) {
        this.cancelWatchdog = this.scheduler.scheduleTimeout(() => {
          this.flushNow()
        }, CURSOR_HIDE_HOLD_MS)
      }
      return
    }

    // Ready to paint cleanly on the next VSync frame
    this.clearWatchdog()
    if (!this.cancelFrame) {
      this.cancelFrame = this.scheduler.scheduleFrame(() => {
        this.flushNow()
      })
    }
  }

  private appendSegment(seg: string): void {
    if (!seg) return
    this.pending += seg
    if (!this.hasEraseInPending && seg.includes('\x1b[') && ERASE_OR_HOME_RE.test(seg)) {
      this.hasEraseInPending = true
    }
    const lastHide = seg.lastIndexOf(HIDE_CURSOR)
    const lastShow = seg.lastIndexOf(SHOW_CURSOR)
    if (lastHide >= 0 || lastShow >= 0) {
      this.cursorHiddenInPending = lastHide > lastShow
    }
  }

  flushNow(): void {
    this.clearFrameSchedule()
    this.clearWatchdog()
    if (this.disposed) return
    const batch = this.pending
    this.pending = ''
    this.cursorHiddenInPending = false
    this.hasEraseInPending = false
    if (batch) {
      this.onFlush(batch)
    }
  }

  dispose(): void {
    this.disposed = true
    this.clearFrameSchedule()
    this.clearWatchdog()
    this.pending = ''
    this.partialEsc = ''
    this.inSyncUpdate = false
    this.cursorHiddenInPending = false
    this.hasEraseInPending = false
  }

  private clearFrameSchedule(): void {
    if (this.cancelFrame) {
      this.cancelFrame()
      this.cancelFrame = null
    }
  }

  private clearWatchdog(): void {
    if (this.cancelWatchdog) {
      this.cancelWatchdog()
      this.cancelWatchdog = null
    }
  }
}
