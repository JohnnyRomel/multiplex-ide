import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import { CanvasAddon } from '@xterm/addon-canvas'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { TerminalFrameBuffer } from '@shared/terminalFrameBuffer'
import {
  analyzePasteSafety,
  cleanCopiedText,
  flattenPasteToSingleLine,
  mapIterm2KeyEvent,
  sanitizePasteText
} from '@shared/terminalKeymap'
import { DEFAULT_TERMINAL_PREFS, type TerminalPrefs, useAppStore } from '@renderer/stores/useAppStore'
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
 * - Full iTerm2 clipboard stack: trailing-space trim, unwrap/join copy, sanitized bracketed paste,
 *   clipboard screenshot auto-upload over SSH, Finder file path paste, OSC 52 feedback, and
 *   session Paste History (`⌘⇧H`).
 */
export interface XtermHandlers {
  onToggleFind?: () => void
  onTogglePasteHistory?: () => void
  onTitleChange?: (title: string) => void
  onBell?: () => void
  onScrollStateChange?: (isScrolledUp: boolean) => void
  onGeometryChange?: (cols: number, rows: number, isInitial: boolean) => void
  onCopiedSelection?: (label?: string) => void
  onConfirmPaste?: (text: string, lineCount: number, preview: string) => void
  onLinkHover?: (uri: string | null) => void
}

export interface XtermEntry {
  terminalId: string
  envId: string
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

/**
 * Copies the active xterm selection with iTerm2 cleanup (trailing-space trimming or line joining),
 * records it in session Paste History, and flashes a subtle feedback pill in the pane header.
 */
export function copyFromTerminal(terminalId: string, opts?: { joinLines?: boolean }): boolean {
  const entry = entries.get(terminalId)
  if (!entry || !entry.term.hasSelection()) return false
  const raw = entry.term.getSelection()
  if (!raw) return false
  const cleaned = cleanCopiedText(raw, {
    trimTrailingSpaces: entry.prefs.trimTrailingSpacesOnCopy,
    joinLines: opts?.joinLines
  })
  if (!cleaned) return false
  window.multiplex.writeClipboardText(cleaned)
  useAppStore.getState().recordClipboardHistory(cleaned, 'copy')
  entry.handlers.onCopiedSelection?.(opts?.joinLines ? 'Copied (1 line)' : 'Copied')
  return true
}

/**
 * Pastes text into a terminal safely (strips bracketed-paste escape injection, enforces multi-line
 * guard when bracketed paste mode is OFF, and records to session Paste History).
 */
export function pasteIntoTerminal(
  terminalId: string,
  text: string,
  opts?: { force?: boolean; recordHistory?: boolean }
): void {
  const entry = entries.get(terminalId)
  if (!entry || !text) return
  const sanitized = sanitizePasteText(text)
  if (!sanitized) return
  if (!opts?.force) {
    const safety = analyzePasteSafety(sanitized, entry.term.modes.bracketedPasteMode)
    if (!safety.safe && entry.handlers.onConfirmPaste) {
      entry.handlers.onConfirmPaste(sanitized, safety.lineCount, safety.preview)
      return
    }
  }
  if (opts?.recordHistory !== false) {
    useAppStore.getState().recordClipboardHistory(sanitized, 'paste')
  }
  entry.term.paste(sanitized)
  entry.term.focus()
}

/**
 * Rich async clipboard paste for terminals:
 * 1) Finder copied files -> shell-quoted local paths (or auto-uploaded remote image for SSH)
 * 2) Plain text -> sanitized paste (optional single-line flatten) + Paste History
 * 3) Clipboard screenshot / image (`⌘⌃⇧4`) -> saved to `/tmp/mide-clip-*.png` locally OR
 *    automatically uploaded via SFTP to remote `/tmp/mide-clip-*.png` and pasted straight into `agy`!
 */
export async function smartPasteIntoTerminal(
  terminalId: string,
  opts?: { flatten?: boolean }
): Promise<void> {
  const entry = entries.get(terminalId)
  if (!entry) return
  try {
    const res = await window.multiplex.readClipboardForTerminal(entry.envId)
    if (res.kind === 'error') {
      if (res.error) useAppStore.getState().addToast('error', res.error)
      return
    }
    if (res.kind === 'empty' || !res.text) return

    if (res.kind === 'image') {
      pasteIntoTerminal(terminalId, res.text, { force: true, recordHistory: true })
      const kb = res.sizeBytes ? ` (${Math.max(1, Math.round(res.sizeBytes / 1024))} KB)` : ''
      entry.handlers.onCopiedSelection?.(res.uploadedTo ? 'Image uploaded' : 'Image pasted')
      useAppStore
        .getState()
        .addToast(
          'info',
          res.uploadedTo
            ? `Uploaded clipboard image${kb} → ${res.uploadedTo}:${res.targetPath}`
            : `Saved clipboard image${kb} → ${res.targetPath}`
        )
      return
    }

    if (res.kind === 'files') {
      pasteIntoTerminal(terminalId, res.text, { force: true, recordHistory: true })
      entry.handlers.onCopiedSelection?.(res.count && res.count > 1 ? `Pasted ${res.count} paths` : 'Path pasted')
      return
    }

    const finalText = opts?.flatten ? flattenPasteToSingleLine(res.text) : res.text
    pasteIntoTerminal(terminalId, finalText, { force: Boolean(opts?.flatten) })
  } catch (err: any) {
    useAppStore.getState().addToast('error', `Paste failed: ${err?.message || err}`)
  }
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
  opts: { envId: string; fontSize: number; theme: ITheme; prefs?: TerminalPrefs }
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
    envId: opts.envId,
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

  registerTerminalInstance(terminalId, term, {
    onCopy: () => copyFromTerminal(terminalId),
    onPaste: () => void smartPasteIntoTerminal(terminalId)
  })

  // OSC 52: copying inside remote tmux / vim / neovim syncs to macOS clipboard + Paste History + badge
  const osc52 = term.parser.registerOscHandler(52, (data) => {
    const decoded = decodeOsc52Payload(data)
    if (decoded !== null) {
      const cleaned = cleanCopiedText(decoded, {
        trimTrailingSpaces: entry.prefs.trimTrailingSpacesOnCopy
      })
      window.multiplex.writeClipboardText(cleaned)
      useAppStore.getState().recordClipboardHistory(cleaned, 'osc52')
      entry.handlers.onCopiedSelection?.('Copied · tmux')
    }
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
      copyFromTerminal(terminalId)
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
        copyFromTerminal(terminalId)
        return false
      }
      if (k === 'v') {
        void smartPasteIntoTerminal(terminalId)
        return false
      }
    }

    if (ev.type === 'keydown' && ev.metaKey) {
      const k = ev.key.toLowerCase()
      if (!ev.shiftKey && !ev.altKey && k === 'f') {
        ev.preventDefault()
        entry.handlers.onToggleFind?.()
        return false
      }
      if (ev.shiftKey && !ev.altKey && k === 'h') {
        ev.preventDefault()
        entry.handlers.onTogglePasteHistory?.()
        return false
      }
      if (!ev.shiftKey && !ev.altKey && k === 'k') {
        ev.preventDefault()
        term.clear()
        return false
      }
      // App-level / iTerm2 / macOS menu shortcuts must never be swallowed by the remote shell
      if (
        ['c', 'v', 'x', 'a', 'p', 't', 'w', 'b', 'j', 'd', ',', 's', '=', '+', '-', '0', '[', ']'].includes(k) ||
        (ev.shiftKey && (k === 'f' || k === 'h' || ev.key === 'Enter')) ||
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
