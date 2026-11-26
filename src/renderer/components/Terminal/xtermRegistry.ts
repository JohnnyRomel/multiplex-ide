import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import { CanvasAddon } from '@xterm/addon-canvas'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { TerminalFrameBuffer } from '@shared/terminalFrameBuffer'
import { analyzePasteSafety, mapIterm2KeyEvent } from '@shared/terminalKeymap'
import { DEFAULT_TERMINAL_PREFS, type TerminalPrefs } from '@renderer/stores/useAppStore'
import {
  decodeOsc52Payload,
  registerTerminalInstance,
  unregisterTerminalInstance
} from '@renderer/utils/clipboardBridge'

/**
 * Persistent xterm.js instances living OUTSIDE the React tree (combining VS Code's performance
 * architecture with iTerm2's calm, rock-solid macOS ergonomics):
 * - `@xterm/addon-canvas` (2D Canvas renderer) + `customGlyphs: true` + Unicode 11 column widths
 * - Native macOS `ui-monospace` (SF Mono) typography, semibold bold weight, iTerm2 minimum contrast,
 *   hollow inactive cursor (`outline`), and steady-by-default cursor (zero jitter).
 * - Zero-flash resize via `proposeDimensions()` + direct `term.resize()` (skipping FitAddon's
 *   legacy `_renderService.clear()` blank flash) with 45ms remote SIGWINCH debounce.
 * - iTerm2 Natural Text Editing (`⌘←/→/⌫`, `⌥←/→/⌫`, `⇧⏎` newline for `agy`), `⌘+Click` URL
 *   protection, optional Copy-on-Select, dynamic `OSC 0/2` titles, visual bell, and bracketed-paste
 *   multi-line safety guard.
 */
export interface XtermHandlers {
  onToggleFind?: () => void
  onTitleChange?: (title: string) => void
  onBell?: () => void
  onScrollStateChange?: (isScrolledUp: boolean) => void
  onGeometryChange?: (cols: number, rows: number, isInitial: boolean) => void
  onCopiedSelection?: () => void
  onConfirmPaste?: (text: string, lineCount: number, preview: string) => void
  onLinkHover?: (uri: string | null) => void
}

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
  copyOnSelectTimer: ReturnType<typeof setTimeout> | null
  lastTitle: string
  lastScrolledUp: boolean
  prefs: TerminalPrefs
  handlers: XtermHandlers
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

export function pasteIntoTerminal(
  terminalId: string,
  text: string,
  opts?: { force?: boolean }
): void {
  const entry = entries.get(terminalId)
  if (!entry || !text) return
  if (!opts?.force) {
    const safety = analyzePasteSafety(text, entry.term.modes.bracketedPasteMode)
    if (!safety.safe && entry.handlers.onConfirmPaste) {
      entry.handlers.onConfirmPaste(text, safety.lineCount, safety.preview)
      return
    }
  }
  entry.term.paste(text)
  entry.term.focus()
}

export function applyTerminalPrefs(entry: XtermEntry, prefs: TerminalPrefs): void {
  const prevContrast = entry.prefs.minimumContrast
  entry.prefs = prefs
  entry.term.options.cursorStyle = prefs.cursorStyle
  entry.term.options.cursorBlink = prefs.cursorBlink
  entry.term.options.macOptionIsMeta = prefs.optionAsMeta
  entry.term.options.minimumContrastRatio = prefs.minimumContrast ? 3 : 1
  if (prevContrast !== prefs.minimumContrast) {
    entry.canvas?.clearTextureAtlas()
  }
}

export function applyTerminalPrefsToAll(prefs: TerminalPrefs): void {
  for (const entry of entries.values()) {
    applyTerminalPrefs(entry, prefs)
  }
}

export function getOrCreateXterm(
  terminalId: string,
  opts: { fontSize: number; theme: ITheme; prefs?: TerminalPrefs }
): XtermEntry {
  const existing = entries.get(terminalId)
  if (existing) return existing

  ensureGlobalDataRouter()

  const prefs = opts.prefs ?? DEFAULT_TERMINAL_PREFS
  const host = document.createElement('div')
  host.style.width = '100%'
  host.style.height = '100%'

  const term = new XTerm({
    allowProposedApi: true,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, "JetBrains Mono", Monaco, monospace',
    fontSize: opts.fontSize,
    fontWeight: '400',
    fontWeightBold: '600',
    lineHeight: 1.18,
    customGlyphs: true,
    rescaleOverlappingGlyphs: true,
    cursorBlink: prefs.cursorBlink,
    cursorStyle: prefs.cursorStyle,
    cursorInactiveStyle: 'outline',
    cursorWidth: 2,
    minimumContrastRatio: prefs.minimumContrast ? 3 : 1,
    macOptionIsMeta: prefs.optionAsMeta,
    macOptionClickForcesSelection: true,
    scrollOnUserInput: true,
    overviewRulerWidth: 8,
    wordSeparator: ' ()[]{}\'",;│─┃',
    fastScrollModifier: 'alt',
    fastScrollSensitivity: 5,
    scrollSensitivity: 1.5,
    scrollback: 20000,
    theme: opts.theme
  })

  const fit = new FitAddon()
  const search = new SearchAddon({ highlightLimit: 1000 })
  const unicode11 = new Unicode11Addon()
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
    copyOnSelectTimer: null,
    lastTitle: '',
    lastScrolledUp: false,
    prefs,
    handlers: {},
    disposeAll: () => {}
  }

  term.loadAddon(fit)
  term.loadAddon(search)
  term.loadAddon(unicode11)
  term.loadAddon(
    new WebLinksAddon(
      (event, uri) => {
        // iTerm2 behavior: require Cmd+Click (or Ctrl+Click) so plain clicks focus/select cleanly
        if (event.metaKey || event.ctrlKey) {
          window.open(uri, '_blank', 'noopener,noreferrer')
        }
      },
      {
        hover: (_event, uri) => entry.handlers.onLinkHover?.(uri),
        leave: () => entry.handlers.onLinkHover?.(null)
      }
    )
  )
  term.unicode.activeVersion = '11'

  registerTerminalInstance(terminalId, term, (text) => pasteIntoTerminal(terminalId, text))

  // OSC 52: copying inside remote tmux / vim / neovim syncs to the macOS clipboard
  const osc52 = term.parser.registerOscHandler(52, (data) => {
    const decoded = decodeOsc52Payload(data)
    if (decoded !== null) window.multiplex.writeClipboardText(decoded)
    return true
  })

  const onInput = term.onData((data) => {
    window.multiplex.writeTerminal(terminalId, data)
  })

  // Dynamic OSC 0/2 title updates (live cwd / running command from zsh / tmux / agy)
  const onTitle = term.onTitleChange((title) => {
    const clean = title.trim()
    entry.lastTitle = clean
    entry.handlers.onTitleChange?.(clean)
  })

  // Visual bell flash (calm iTerm2 alternative to intrusive audio beep)
  const onBell = term.onBell(() => {
    entry.handlers.onBell?.()
  })

  // Track scrolled-up state cleanly without React churn during fast streaming
  const updateScrollState = () => {
    const buf = term.buffer.active
    const scrolledUp = buf.type === 'normal' && buf.viewportY < buf.baseY
    if (scrolledUp !== entry.lastScrolledUp) {
      entry.lastScrolledUp = scrolledUp
      entry.handlers.onScrollStateChange?.(scrolledUp)
    }
  }
  const onScroll = term.onScroll(updateScrollState)
  const onWriteParsed = term.onWriteParsed(updateScrollState)

  // iTerm2 optional Copy-on-Select (debounced so mouse drag doesn't spam NSPasteboard)
  const onSelection = term.onSelectionChange(() => {
    if (!entry.prefs.copyOnSelect) return
    if (entry.copyOnSelectTimer !== null) {
      clearTimeout(entry.copyOnSelectTimer)
      entry.copyOnSelectTimer = null
    }
    entry.copyOnSelectTimer = setTimeout(() => {
      entry.copyOnSelectTimer = null
      if (!entry.prefs.copyOnSelect || !term.hasSelection()) return
      const sel = term.getSelection()
      if (sel) {
        window.multiplex.writeClipboardText(sel)
        entry.handlers.onCopiedSelection?.()
      }
    }, 90)
  })

  term.attachCustomKeyEventHandler((ev) => {
    // NEVER intercept active IME composition (Chinese Pinyin / Japanese / Korean preedit)
    if (ev.isComposing || ev.keyCode === 229) return true

    // iTerm2 Natural Text Editing (`⌘←/→/⌫`, `⌥←/→/⌫`) & `⇧⏎` newline for `agy`
    const mapped = mapIterm2KeyEvent(ev)
    if (mapped !== null) {
      ev.preventDefault()
      window.multiplex.writeTerminal(terminalId, mapped)
      return false
    }

    if (ev.type === 'keydown' && ev.ctrlKey && ev.shiftKey && !ev.metaKey && !ev.altKey) {
      const k = ev.key.toLowerCase()
      if (k === 'c') {
        if (term.hasSelection()) window.multiplex.writeClipboardText(term.getSelection())
        return false
      }
      if (k === 'v') {
        const text = window.multiplex.readClipboardText()
        if (text) pasteIntoTerminal(terminalId, text)
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
      // App-level / iTerm2 / macOS menu shortcuts must never be swallowed by the remote shell
      if (
        ['c', 'v', 'x', 'a', 'p', 't', 'w', 'b', 'j', 'd', ',', 's', '=', '+', '-', '0', '[', ']'].includes(k) ||
        (ev.shiftKey && (k === 'f' || ev.key === 'Enter')) ||
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
    if (entry.copyOnSelectTimer !== null) {
      clearTimeout(entry.copyOnSelectTimer)
      entry.copyOnSelectTimer = null
    }
    frameBuffer.dispose()
    onInput.dispose()
    onTitle.dispose()
    onBell.dispose()
    onScroll.dispose()
    onWriteParsed.dispose()
    onSelection.dispose()
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
 * Fits xterm locally with ZERO blank-canvas flash (calls `proposeDimensions()` + `term.resize()`
 * directly instead of FitAddon's legacy `_renderService.clear()`!) and syncs PTY cols/rows over IPC.
 * Continuous drag resizes are debounced by 45ms so SSH/tmux/agy isn't flooded with 60 SIGWINCH/s!
 */
export function fitXterm(entry: XtermEntry, opts?: { force?: boolean; immediateIpc?: boolean }): boolean {
  const parent = entry.host.parentElement
  if (!entry.opened || !parent || !parent.offsetWidth || !parent.offsetHeight) return false
  try {
    const dims = entry.fit.proposeDimensions()
    if (!dims || Number.isNaN(dims.cols) || Number.isNaN(dims.rows)) return false
    const cols = Math.max(2, dims.cols)
    const rows = Math.max(1, dims.rows)

    const prev = entry.lastSentSize
    const isFirstFit = prev === null
    const localChanged = entry.term.cols !== cols || entry.term.rows !== rows
    if (localChanged) {
      entry.term.resize(cols, rows)
    }

    const sizeChanged = !prev || prev.cols !== cols || prev.rows !== rows
    if (!opts?.force && !sizeChanged) {
      return false
    }

    entry.lastSentSize = { cols, rows }
    if (sizeChanged) {
      entry.handlers.onGeometryChange?.(cols, rows, isFirstFit)
    }

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
    return sizeChanged
  } catch {
    return false
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
