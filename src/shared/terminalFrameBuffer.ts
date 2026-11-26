/**
 * Low-latency, anti-flicker terminal stream coalescer modeled after VS Code / WezTerm / Ghostty:
 *
 * 1. **0ms Fast-Path for Interactive Typing & Normal Output**:
 *    xterm.js already batches `term.write()` calls onto the upcoming VSync frame via its internal
 *    `RenderDebouncer`. Adding a second `requestAnimationFrame` in front of `term.write()` wasted an
 *    extra 16.6ms frame on every keystroke! Plain echoed characters and complete frames now flush
 *    synchronously in 0ms straight into `term.write()`.
 *
 * 2. **DEC Mode 2026 Synchronized Output (`\x1b[?2026h` ... `\x1b[?2026l`)**:
 *    Holds partial TUI frames across split SSH TCP packets until `ESU` arrives (64ms safety cap),
 *    then flushes synchronously (0ms) as a single atomic `term.write()`.
 *
 * 3. **Sliding Quiet-Window Burst Coalescing for `tmux` / Ink TUI Redraws (`agy`, `claude`, `vim`)**:
 *    Older `tmux` (e.g. 2.8) strips DEC 2026 markers and Often keeps the hardware cursor hidden
 *    (`cursor_flag=0`) for the entire turn while emitting multi-packet `\x1b[row;colH` + `\x1b[K`
 *    diffs every 80ms. Back-to-back TCP packets of one redraw arrive 0.2–2ms apart; a 4ms sliding
 *    quiet window (bounded at 14ms max hold, and flushing immediately on `\x1b[?25h`) merges the
 *    entire multi-packet redraw into ONE atomic `term.write()` with zero mid-frame flicker!
 */

const BSU = '\x1b[?2026h'
const ESU = '\x1b[?2026l'
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'
const TERM_RESET_RE = /\x1bc|\x1b\[!p/

// Matches TUI multi-line/screen redraw primitives: erase line/screen, 2D cursor jump, multi-line move, line insert/delete
const TUI_REDRAW_RE = /\x1b\[(?:[012]?[KJ]|\d*;\d*[Hf]|\d+[ABCDEFG]|\d*[LM])/

const MAX_BUFFER_BYTES = 256 * 1024
const SYNC_MAX_HOLD_MS = 64
const BURST_QUIET_MS = 4
const BURST_MAX_HOLD_MS = 14
const PARTIAL_ESC_HOLD_MS = 8

export interface FrameBufferScheduler {
  now?: () => number
  scheduleTimeout: (cb: () => void, ms: number) => () => void
}

function defaultScheduler(): FrameBufferScheduler {
  return {
    now: () => performance.now(),
    scheduleTimeout: (cb, ms) => {
      const id = setTimeout(cb, ms)
      return () => clearTimeout(id)
    }
  }
}

/**
 * Detects an incomplete trailing escape sequence at the end of a TCP chunk (e.g. split `\x1b[?2026h`,
 * `\x1b[?25l`, or `\x1b[38;2;`) so we never split a control sequence across two `term.write()` calls.
 */
function findIncompleteEscapeTailLength(str: string): number {
  const maxScan = Math.min(str.length, 48)
  for (let offset = 1; offset <= maxScan; offset++) {
    const idx = str.length - offset
    if (str.charCodeAt(idx) !== 0x1b) continue
    const tail = str.slice(idx)
    if (tail.length === 1) return 1
    // Strict prefix of DEC 2026 / cursor private mode CSI (`\x1b[?...` before final `h`/`l`)
    if (
      (tail.length < BSU.length && (BSU.startsWith(tail) || ESU.startsWith(tail))) ||
      (tail.length < HIDE_CURSOR.length && (HIDE_CURSOR.startsWith(tail) || SHOW_CURSOR.startsWith(tail)))
    ) {
      return tail.length
    }
    // Incomplete CSI sequence `\x1b[` followed only by parameter/intermediate bytes (`0x20..0x3f`) with no final byte yet
    if (tail.charCodeAt(1) === 0x5b) {
      let complete = false
      for (let i = 2; i < tail.length; i++) {
        const c = tail.charCodeAt(i)
        if (c >= 0x40 && c <= 0x7e) {
          complete = true
          break
        }
        if (c < 0x20 || c > 0x3f) {
          complete = true
          break
        }
      }
      return complete ? 0 : tail.length
    }
    return 0
  }
  return 0
}

export class TerminalFrameBuffer {
  private pending = ''
  private partialEsc = ''
  private inSyncUpdate = false
  private cursorKnownHidden = false
  private cursorHiddenInPending = false
  private hasRedrawInPending = false
  private holdStartedAt = 0
  private cancelTimer: (() => void) | null = null
  private disposed = false
  private scheduler: FrameBufferScheduler

  constructor(
    private onFlush: (batch: string) => void,
    scheduler?: FrameBufferScheduler
  ) {
    this.scheduler = scheduler ?? defaultScheduler()
  }

  private now(): number {
    return this.scheduler.now ? this.scheduler.now() : Date.now()
  }

  push(rawChunk: string): void {
    if (this.disposed || !rawChunk) return

    const combined = this.partialEsc + rawChunk
    this.partialEsc = ''

    const partialLen = findIncompleteEscapeTailLength(combined)
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

      this.inSyncUpdate = isBsu
      pos = nextIdx + (isBsu ? BSU.length : ESU.length)
    }

    // Guard against huge streaming logs (`cat huge.log`) hoarding memory
    if (this.pending.length >= MAX_BUFFER_BYTES) {
      this.flushNow()
      return
    }

    if (!this.pending) {
      // Only a partial trailing `\x1b...` is waiting; arm a short safety flush in case no bytes follow
      if (this.partialEsc && !this.cancelTimer) {
        this.armPartialEscTimer()
      }
      return
    }

    // 1. DEC 2026 Synchronized Output active -> hold until `\x1b[?2026l` (bounded by 64ms safety cap)
    if (this.inSyncUpdate) {
      if (!this.holdStartedAt) this.holdStartedAt = this.now()
      const elapsed = Math.max(0, this.now() - this.holdStartedAt)
      const remaining = Math.max(1, SYNC_MAX_HOLD_MS - elapsed)
      this.armTimer(() => {
        this.inSyncUpdate = false
        this.flushNow()
      }, remaining)
      return
    }

    // 2. Non-2026 TUI redraw burst (either unclosed `?25l` + erase/jump, OR TUI app like `agy` keeping
    //    cursor hidden across ticks while sending multi-packet `\x1b[row;colH` + `\x1b[K` redraws):
    //    coalesce back-to-back TCP packets with a 4ms sliding quiet window (capped at 14ms total).
    const shouldCoalesceBurst =
      this.hasRedrawInPending && (this.cursorHiddenInPending || this.cursorKnownHidden)

    if (shouldCoalesceBurst) {
      if (!this.holdStartedAt) this.holdStartedAt = this.now()
      const elapsed = Math.max(0, this.now() - this.holdStartedAt)
      if (elapsed >= BURST_MAX_HOLD_MS) {
        this.flushNow()
        return
      }
      const waitMs = Math.max(1, Math.min(BURST_QUIET_MS, BURST_MAX_HOLD_MS - elapsed))
      this.armTimer(() => {
        this.flushNow()
      }, waitMs)
      return
    }

    // 3. Fast path (interactive keystroke echo, normal command output, or completed `?25l...`?25h` / ESU frame):
    //    flush synchronously in 0ms! xterm's internal RenderDebouncer paints on the very next VSync.
    this.flushNow()
  }

  private appendSegment(seg: string): void {
    if (!seg) return
    this.pending += seg

    if (TERM_RESET_RE.test(seg)) {
      this.cursorKnownHidden = false
      this.cursorHiddenInPending = false
    }

    if (!this.hasRedrawInPending && seg.includes('\x1b[') && TUI_REDRAW_RE.test(seg)) {
      this.hasRedrawInPending = true
    }

    const lastHide = seg.lastIndexOf(HIDE_CURSOR)
    const lastShow = seg.lastIndexOf(SHOW_CURSOR)
    if (lastHide >= 0 || lastShow >= 0) {
      const hidden = lastHide > lastShow
      this.cursorHiddenInPending = hidden
      this.cursorKnownHidden = hidden
    }
  }

  private armTimer(cb: () => void, ms: number): void {
    this.clearTimer()
    this.cancelTimer = this.scheduler.scheduleTimeout(() => {
      this.cancelTimer = null
      cb()
    }, ms)
  }

  private armPartialEscTimer(): void {
    this.cancelTimer = this.scheduler.scheduleTimeout(() => {
      this.cancelTimer = null
      const leftover = this.partialEsc
      this.partialEsc = ''
      if (leftover) {
        this.appendSegment(leftover)
        this.flushNow()
      }
    }, PARTIAL_ESC_HOLD_MS)
  }

  flushNow(): void {
    this.clearTimer()
    if (this.disposed) return
    const batch = this.pending
    this.pending = ''
    this.cursorHiddenInPending = false
    this.hasRedrawInPending = false
    this.holdStartedAt = 0
    if (batch) {
      this.onFlush(batch)
    }
    if (this.partialEsc && !this.cancelTimer) {
      this.armPartialEscTimer()
    }
  }

  dispose(): void {
    this.disposed = true
    this.clearTimer()
    this.pending = ''
    this.partialEsc = ''
    this.inSyncUpdate = false
    this.cursorKnownHidden = false
    this.cursorHiddenInPending = false
    this.hasRedrawInPending = false
    this.holdStartedAt = 0
  }

  private clearTimer(): void {
    if (this.cancelTimer) {
      this.cancelTimer()
      this.cancelTimer = null
    }
  }
}
