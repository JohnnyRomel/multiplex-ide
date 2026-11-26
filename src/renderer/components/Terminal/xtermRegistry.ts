import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import { CanvasAddon } from '@xterm/addon-canvas'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { TerminalFrameBuffer } from '@shared/terminalFrameBuffer'
import {
  decodeOsc52Payload,
  registerTerminalInstance,
  unregisterTerminalInstance
} from '@renderer/utils/clipboardBridge'

/**
 * Persistent xterm.js instances living OUTSIDE the React tree (modeled after VS Code's `XtermTerminal`):
 * - Uses `@xterm/addon-canvas` (2D Canvas renderer): 10x–20x smoother than DOM spans with zero
 *   `getBoundingClientRect()` layout reflow, native `CursorBlinkStateManager` (locks cursor solid
 *   visible while typing!), pixel-perfect `customGlyphs` box-drawing, and zero WebGL context/atlas bugs.
 * - Uses `@xterm/addon-unicode11` (`activeVersion = '11'`) so CJK / emoji / TUI symbols match
 *   modern zsh / tmux / Ink column widths to the exact cell.
 * - Single O(1) IPC data router instead of O(N) broadcast listeners across all open tabs.
 * - Debounced PTY SIGWINCH during continuous sash drags so remote `tmux` / `agy` never chokes.
 */
export interface XtermEntry {
  terminalId: string
  term: XTerm
  fit: FitAddon
  search: SearchAddon
  canvas: CanvasAddon | null
  frameBuffer: TerminalFrameBuffer
  host: HTMLDivElement
  opened: boolean
  lastSentSize: { cols: number; rows: number } | null
  resizeIpcTimer: ReturnType<typeof setTimeout> | null
  handlers: { onToggleFind?: () => void }
  disposeAll: () => void
}

const entries = new Map<string, XtermEntry>()
let globalDataRouterInstalled = false

function ensureGlobalDataRouter(): void {
  if (globalDataRouterInstalled || typeof window === 'undefined' || !window.multiplex) return
  globalDataRouterInstalled = true
  window.multiplex.onTerminalData((id, data) => {
    const target = entries.get(id)
    if (target) {
      target.frameBuffer.push(data)
    }
  })
}

export function getXterm(terminalId: string): XtermEntry | undefined {
  return entries.get(terminalId)
}

export function getOrCreateXterm(
  terminalId: string,
  opts: { fontSize: number; theme: ITheme }
): XtermEntry {
  const existing = entries.get(terminalId)
  if (existing) return existing

  ensureGlobalDataRouter()

  const host = document.createElement('div')
  host.style.width = '100%'
  host.style.height = '100%'

  const term = new XTerm({
    allowProposedApi: true,
    fontFamily: 'Menlo, "SF Mono", "JetBrains Mono", Monaco, monospace',
    fontSize: opts.fontSize,
    lineHeight: 1.15,
    customGlyphs: true,
    rescaleOverlappingGlyphs: true,
    cursorBlink: true,
    cursorStyle: 'block',
    cursorWidth: 2,
    macOptionIsMeta: true,
    macOptionClickForcesSelection: true,
    fastScrollModifier: 'alt',
    fastScrollSensitivity: 5,
    scrollSensitivity: 1.5,
    scrollback: 15000,
    theme: opts.theme
  })

  const fit = new FitAddon()
  const search = new SearchAddon()
  const unicode11 = new Unicode11Addon()
  term.loadAddon(fit)
  term.loadAddon(search)
  term.loadAddon(unicode11)
  term.loadAddon(new WebLinksAddon())
  term.unicode.activeVersion = '11'

  const frameBuffer = new TerminalFrameBuffer((batch) => term.write(batch))

  const entry: XtermEntry = {
    terminalId,
    term,
    fit,
    search,
    canvas: null,
    frameBuffer,
    host,
    opened: false,
    lastSentSize: null,
    resizeIpcTimer: null,
    handlers: {},
    disposeAll: () => {}
  }

  registerTerminalInstance(terminalId, term)

  // OSC 52: copying inside remote tmux / vim / neovim syncs to the macOS clipboard
  const osc52 = term.parser.registerOscHandler(52, (data) => {
    const decoded = decodeOsc52Payload(data)
    if (decoded !== null) window.multiplex.writeClipboardText(decoded)
    return true
  })

  const onInput = term.onData((data) => {
    window.multiplex.writeTerminal(terminalId, data)
  })

  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type === 'keydown' && ev.ctrlKey && ev.shiftKey && !ev.metaKey && !ev.altKey) {
      const k = ev.key.toLowerCase()
      if (k === 'c') {
        if (term.hasSelection()) window.multiplex.writeClipboardText(term.getSelection())
        return false
      }
      if (k === 'v') {
        const text = window.multiplex.readClipboardText()
        if (text) term.paste(text)
        return false
      }
    }
    if (ev.type === 'keydown' && ev.metaKey) {
      const k = ev.key.toLowerCase()
      if (!ev.shiftKey && !ev.altKey && k === 'f') {
        entry.handlers.onToggleFind?.()
        return false
      }
      if (!ev.shiftKey && !ev.altKey && k === 'k') {
        term.clear()
        return false
      }
      // App-level / macOS menu shortcuts must never be swallowed by the remote shell
      if (
        ['c', 'v', 'x', 'a', 'p', 't', 'w', 'b', 'j', ',', 's', '=', '+', '-', '0', '[', ']'].includes(k) ||
        (ev.shiftKey && k === 'f') ||
        ev.code === 'Backslash' ||
        (k >= '1' && k <= '9')
      ) {
        return false
      }
    }
    return true
  })

  entry.disposeAll = () => {
    if (entry.resizeIpcTimer !== null) {
      clearTimeout(entry.resizeIpcTimer)
      entry.resizeIpcTimer = null
    }
    frameBuffer.dispose()
    onInput.dispose()
    osc52.dispose()
    unregisterTerminalInstance(terminalId, term)
    try {
      entry.canvas?.dispose()
      entry.canvas = null
    } catch {
      // ignore
    }
    try {
      term.dispose()
    } catch {
      // ignore
    }
    host.remove()
  }

  entries.set(terminalId, entry)

  // Main process buffers PTY output produced before this entry existed; flush it now
  // so the first shell prompt / SSH banner is never lost.
  window.multiplex.notifyTerminalReady(terminalId)
  return entry
}

/** Moves the persistent xterm host into `container` (opening xterm + 2D Canvas renderer on first attach). */
export function attachXterm(entry: XtermEntry, container: HTMLElement): void {
  if (entry.host.parentElement !== container) {
    container.appendChild(entry.host)
  }
  if (!entry.opened) {
    entry.term.open(entry.host)
    entry.opened = true
    try {
      const canvasAddon = new CanvasAddon()
      entry.term.loadAddon(canvasAddon)
      entry.canvas = canvasAddon
    } catch {
      // Graceful fallback to DOM renderer if 2D canvas is unavailable
    }
  }
}

/** Detaches the host element WITHOUT disposing xterm (scrollback survives React remounts). */
export function detachXterm(entry: XtermEntry, container: HTMLElement): void {
  if (entry.host.parentElement === container) {
    container.removeChild(entry.host)
  }
}

/**
 * Fits xterm locally right away (60/120fps visual resize) and syncs PTY cols/rows over IPC.
 * Continuous drag resizes are debounced by 45ms so SSH/tmux/agy isn't flooded with 60 SIGWINCH/s!
 */
export function fitXterm(entry: XtermEntry, opts?: { force?: boolean; immediateIpc?: boolean }): void {
  const parent = entry.host.parentElement
  if (!entry.opened || !parent || !parent.offsetWidth || !parent.offsetHeight) return
  try {
    entry.fit.fit()
    const { cols, rows } = entry.term
    const prev = entry.lastSentSize
    if (!opts?.force && prev && prev.cols === cols && prev.rows === rows) {
      return
    }
    const isFirstFit = prev === null
    entry.lastSentSize = { cols, rows }

    if (entry.resizeIpcTimer !== null) {
      clearTimeout(entry.resizeIpcTimer)
      entry.resizeIpcTimer = null
    }

    if (isFirstFit || opts?.force || opts?.immediateIpc) {
      window.multiplex.resizeTerminal(entry.terminalId, cols, rows)
    } else {
      entry.resizeIpcTimer = setTimeout(() => {
        entry.resizeIpcTimer = null
        window.multiplex.resizeTerminal(entry.terminalId, entry.term.cols, entry.term.rows)
      }, 45)
    }
  } catch {
    // ignore layout races
  }
}

export function disposeXterm(terminalId: string): void {
  const entry = entries.get(terminalId)
  if (!entry) return
  entries.delete(terminalId)
  entry.disposeAll()
}

/** Disposes every persistent xterm whose terminal no longer exists in the store. */
export function pruneXterms(liveTerminalIds: Set<string>): void {
  for (const id of Array.from(entries.keys())) {
    if (!liveTerminalIds.has(id)) disposeXterm(id)
  }
}

export function forEachXterm(fn: (entry: XtermEntry) => void): void {
  for (const entry of entries.values()) fn(entry)
}
