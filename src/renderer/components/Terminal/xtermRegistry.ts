import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { TerminalFrameBuffer } from '@shared/terminalFrameBuffer'
import {
  decodeOsc52Payload,
  registerTerminalInstance,
  unregisterTerminalInstance
} from '@renderer/utils/clipboardBridge'

/**
 * Persistent xterm.js instances that live OUTSIDE the React tree.
 *
 * React remounts `<TerminalInstance>` whenever the split layout tree changes shape (splitting a
 * pane wraps the existing leaf into an `<Allotment>`, closing a split unwraps it). Previously that
 * disposed and recreated xterm, wiping the pane's scrollback on every split/close. Now the xterm
 * host element is simply re-parented into the new container (same approach VS Code uses), and the
 * instance is only disposed when its terminal is actually removed from the store.
 */
export interface XtermEntry {
  terminalId: string
  term: XTerm
  fit: FitAddon
  search: SearchAddon
  host: HTMLDivElement
  opened: boolean
  lastSentSize: { cols: number; rows: number } | null
  handlers: { onToggleFind?: () => void }
  disposeAll: () => void
}

const entries = new Map<string, XtermEntry>()

export function getXterm(terminalId: string): XtermEntry | undefined {
  return entries.get(terminalId)
}

export function getOrCreateXterm(
  terminalId: string,
  opts: { fontSize: number; theme: Record<string, string> }
): XtermEntry {
  const existing = entries.get(terminalId)
  if (existing) return existing

  const host = document.createElement('div')
  host.style.width = '100%'
  host.style.height = '100%'

  const term = new XTerm({
    fontFamily: 'Menlo, "SF Mono", "JetBrains Mono", Monaco, monospace',
    fontSize: opts.fontSize,
    lineHeight: 1.25,
    cursorBlink: true,
    cursorStyle: 'block',
    macOptionIsMeta: true,
    macOptionClickForcesSelection: true,
    scrollback: 15000,
    theme: opts.theme
  })

  const fit = new FitAddon()
  const search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(search)
  term.loadAddon(new WebLinksAddon())

  const entry: XtermEntry = {
    terminalId,
    term,
    fit,
    search,
    host,
    opened: false,
    lastSentSize: null,
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

  // Coalesce fragmented SSH packets + DEC 2026 / erase+redraw cycles into atomic VSync writes
  const frameBuffer = new TerminalFrameBuffer((batch) => term.write(batch))
  const offIpc = window.multiplex.onTerminalData((id, data) => {
    if (id === terminalId) frameBuffer.push(data)
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
    frameBuffer.dispose()
    offIpc()
    onInput.dispose()
    osc52.dispose()
    unregisterTerminalInstance(terminalId, term)
    try {
      term.dispose()
    } catch {
      // ignore
    }
    host.remove()
  }

  entries.set(terminalId, entry)

  // Main process buffers PTY output produced before this subscription existed; flush it now
  // so the first shell prompt / SSH banner is never lost.
  window.multiplex.notifyTerminalReady(terminalId)
  return entry
}

/** Moves the persistent xterm host into `container` (opening xterm on first attach). */
export function attachXterm(entry: XtermEntry, container: HTMLElement): void {
  if (entry.host.parentElement !== container) {
    container.appendChild(entry.host)
  }
  if (!entry.opened) {
    // Intentionally xterm's built-in DOM renderer (no WebGL addon): avoids macOS ANGLE/Metal
    // glyph atlas corruption across hidden tabs, sleep/wake and Retina scaling.
    entry.term.open(entry.host)
    entry.opened = true
  }
}

/** Detaches the host element WITHOUT disposing xterm (scrollback survives React remounts). */
export function detachXterm(entry: XtermEntry, container: HTMLElement): void {
  if (entry.host.parentElement === container) {
    container.removeChild(entry.host)
  }
}

/** Fits xterm to its container and syncs PTY size only when cols/rows actually changed. */
export function fitXterm(entry: XtermEntry, force = false): void {
  const parent = entry.host.parentElement
  if (!entry.opened || !parent || !parent.offsetWidth || !parent.offsetHeight) return
  try {
    entry.fit.fit()
    const { cols, rows } = entry.term
    const prev = entry.lastSentSize
    if (force || !prev || prev.cols !== cols || prev.rows !== rows) {
      entry.lastSentSize = { cols, rows }
      window.multiplex.resizeTerminal(entry.terminalId, cols, rows)
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
