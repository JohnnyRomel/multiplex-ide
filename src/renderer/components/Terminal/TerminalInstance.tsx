import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Terminal as XTerm } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { ISearchOptions, SearchAddon } from '@xterm/addon-search'
import {
  AlertTriangle,
  ArrowDown,
  Check,
  ChevronDown,
  ChevronUp,
  Columns2,
  Maximize2,
  Minimize2,
  Plus,
  RefreshCw,
  RotateCw,
  Rows2,
  Search,
  Trash2,
  WifiOff,
  X
} from 'lucide-react'
import type { EditorThemeId, RecoverableTmuxSession } from '@shared/types'
import { flattenPasteToSingleLine } from '@shared/terminalKeymap'
import { useAppStore } from '@renderer/stores/useAppStore'
import {
  attachXterm,
  detachXterm,
  fitXterm,
  getOrCreateXterm,
  getXterm,
  pasteIntoTerminal
} from './xtermRegistry'

export function getXtermTheme(theme: EditorThemeId) {
  if (theme === 'mariana') {
    return {
      background: '#272e36',
      foreground: '#d8dee9',
      cursor: '#f9ae58',
      cursorAccent: '#272e36',
      selectionBackground: 'rgba(102, 153, 204, 0.36)',
      selectionInactiveBackground: 'rgba(102, 153, 204, 0.18)',
      black: '#1e232a',
      red: '#ec5f67',
      green: '#99c794',
      yellow: '#fac863',
      blue: '#6699cc',
      magenta: '#c594c5',
      cyan: '#5fb3b3',
      white: '#d8dee9',
      brightBlack: '#65737e',
      brightRed: '#ec5f67',
      brightGreen: '#99c794',
      brightYellow: '#f99157',
      brightBlue: '#6699cc',
      brightMagenta: '#c594c5',
      brightCyan: '#5fb3b3',
      brightWhite: '#ffffff'
    }
  }
  if (theme === 'boxy') {
    return {
      background: '#21252b',
      foreground: '#dcdfe4',
      cursor: '#528bff',
      cursorAccent: '#21252b',
      selectionBackground: 'rgba(97, 175, 239, 0.34)',
      selectionInactiveBackground: 'rgba(97, 175, 239, 0.17)',
      black: '#181a1f',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#dcdfe4',
      brightBlack: '#5c6370',
      brightRed: '#e06c75',
      brightGreen: '#98c379',
      brightYellow: '#d19a66',
      brightBlue: '#61afef',
      brightMagenta: '#c678dd',
      brightCyan: '#56b6c2',
      brightWhite: '#ffffff'
    }
  }
  return {
    background: '#22231e',
    foreground: '#f8f8f2',
    cursor: '#f8f8f0',
    cursorAccent: '#22231e',
    selectionBackground: 'rgba(166, 226, 46, 0.28)',
    selectionInactiveBackground: 'rgba(255, 255, 255, 0.12)',
    black: '#272822',
    red: '#f92672',
    green: '#a6e22e',
    yellow: '#e6db74',
    blue: '#66d9ef',
    magenta: '#ae81ff',
    cyan: '#66d9ef',
    white: '#f8f8f2',
    brightBlack: '#75715e',
    brightRed: '#f92672',
    brightGreen: '#a6e22e',
    brightYellow: '#fd971f',
    brightBlue: '#66d9ef',
    brightMagenta: '#ae81ff',
    brightCyan: '#a1efe4',
    brightWhite: '#ffffff'
  }
}

const SEARCH_DECORATIONS: ISearchOptions['decorations'] = {
  matchBackground: '#5e4b1c',
  matchBorder: '#8c6d1f',
  matchOverviewRuler: '#d9a441',
  activeMatchBackground: '#f9ae58',
  activeMatchBorder: '#ffd194',
  activeMatchColorOverviewRuler: '#f9ae58'
}

function formatSessionAge(ageSec: number): string {
  if (ageSec < 60) return 'now'
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`
  return `${Math.floor(ageSec / 86400)}d ago`
}

interface Props {
  envId: string
  tabId: string
  paneId: string
  terminalId: string
  title: string
  isVisible: boolean
  paneCount: number
  isZoomed: boolean
}

export const TerminalInstance: React.FC<Props> = ({
  envId,
  tabId,
  paneId,
  terminalId,
  title,
  isVisible,
  paneCount,
  isZoomed
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)

  const theme = useAppStore((s) => s.theme)
  const terminalFontSize = useAppStore((s) => s.terminalFontSize)
  const terminalPrefs = useAppStore((s) => s.terminalPrefs)
  const focusedTerminalId = useAppStore((s) => s.focusedTerminalId)
  const setFocusedPane = useAppStore((s) => s.setFocusedPane)
  const splitTerminal = useAppStore((s) => s.splitTerminal)
  const closeTerminal = useAppStore((s) => s.closeTerminal)
  const toggleZoomPane = useAppStore((s) => s.toggleZoomPane)
  const updateTerminalPrefs = useAppStore((s) => s.updateTerminalPrefs)
  const reconnectTerminal = useAppStore((s) => s.reconnectTerminal)
  const pauseTerminalReconnect = useAppStore((s) => s.pauseTerminalReconnect)
  const switchTerminalTmuxSession = useAppStore((s) => s.switchTerminalTmuxSession)
  const listRemoteTmuxSessions = useAppStore((s) => s.listRemoteTmuxSessions)
  const killRemoteTmuxSession = useAppStore((s) => s.killRemoteTmuxSession)
  const pruneStaleTmuxSessions = useAppStore((s) => s.pruneStaleTmuxSessions)
  const termStatus = useAppStore((s) => s.terminalStatuses[terminalId])
  const env = useAppStore((s) => s.environments.find((e) => e.id === envId))

  // iTerm2 Find Overlay state
  const [showFind, setShowFind] = useState(false)
  const [findText, setFindText] = useState('')
  const [findCase, setFindCase] = useState(false)
  const [findRegex, setFindRegex] = useState(false)
  const [findResult, setFindResult] = useState<{ index: number; count: number } | null>(null)

  // iTerm2 Dynamic Title, Visual Bell, Geometry HUD, Scroll Pill, Link Hint, Copy Toast & Paste Guard
  const [dynamicTitle, setDynamicTitle] = useState('')
  const [bellFlash, setBellFlash] = useState(false)
  const [isScrolledUp, setIsScrolledUp] = useState(false)
  const [geometryHud, setGeometryHud] = useState<{ cols: number; rows: number } | null>(null)
  const [copiedBadge, setCopiedBadge] = useState(false)
  const [hoverLink, setHoverLink] = useState<string | null>(null)
  const [pendingPaste, setPendingPaste] = useState<{ text: string; lineCount: number; preview: string } | null>(null)

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [showTmuxMenu, setShowTmuxMenu] = useState(false)
  const [tmuxMenuPos, setTmuxMenuPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 })
  const [tmuxSessions, setTmuxSessions] = useState<RecoverableTmuxSession[]>([])
  const [tmuxLoading, setTmuxLoading] = useState(false)
  const tmuxMenuRef = useRef<HTMLDivElement>(null)
  const tmuxBtnRef = useRef<HTMLButtonElement>(null)

  const hudTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isFocused = focusedTerminalId === terminalId
  const shouldDim = paneCount > 1 && !isZoomed && !isFocused && terminalPrefs.dimInactivePanes
  const connState = termStatus?.state || (env?.kind === 'local' ? 'connected' : 'connecting')

  const refreshTmuxList = async () => {
    setTmuxLoading(true)
    try {
      const list = await listRemoteTmuxSessions(envId)
      setTmuxSessions(list)
    } finally {
      setTmuxLoading(false)
    }
  }

  const runSearch = useCallback(
    (query: string, dir: 'next' | 'prev', opts?: { caseSensitive?: boolean; regex?: boolean; incremental?: boolean }) => {
      const addon = searchRef.current
      if (!addon) return
      if (!query) {
        addon.clearDecorations()
        setFindResult(null)
        return
      }
      const searchOpts: ISearchOptions = {
        caseSensitive: opts?.caseSensitive ?? findCase,
        regex: opts?.regex ?? findRegex,
        incremental: opts?.incremental ?? false,
        decorations: SEARCH_DECORATIONS
      }
      if (dir === 'prev') addon.findPrevious(query, searchOpts)
      else addon.findNext(query, searchOpts)
    },
    [findCase, findRegex]
  )

  const closeFind = useCallback(() => {
    setShowFind(false)
    setFindResult(null)
    searchRef.current?.clearDecorations()
    xtermRef.current?.focus()
  }, [])

  const isVisibleRef = useRef(isVisible)
  isVisibleRef.current = isVisible

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const initState = useAppStore.getState()
    const entry = getOrCreateXterm(terminalId, {
      fontSize: initState.terminalFontSize,
      theme: getXtermTheme(initState.theme),
      prefs: initState.terminalPrefs
    })

    if (entry.lastTitle) setDynamicTitle(entry.lastTitle)
    setIsScrolledUp(entry.lastScrolledUp)

    entry.handlers.onToggleFind = () => {
      setShowFind((prev) => {
        if (prev) {
          entry.search.clearDecorations()
          setFindResult(null)
          requestAnimationFrame(() => entry.term.focus())
          return false
        }
        requestAnimationFrame(() => {
          findInputRef.current?.focus()
          findInputRef.current?.select()
        })
        return true
      })
    }
    entry.handlers.onTitleChange = (t) => setDynamicTitle(t)
    entry.handlers.onScrollStateChange = (scrolledUp) => setIsScrolledUp(scrolledUp)
    entry.handlers.onLinkHover = (uri) => setHoverLink(uri)
    entry.handlers.onConfirmPaste = (text, lineCount, preview) => {
      setPendingPaste({ text, lineCount, preview })
    }
    entry.handlers.onCopiedSelection = () => {
      setCopiedBadge(true)
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = setTimeout(() => setCopiedBadge(false), 950)
    }
    entry.handlers.onBell = () => {
      setBellFlash(false)
      requestAnimationFrame(() => setBellFlash(true))
      if (bellTimerRef.current) clearTimeout(bellTimerRef.current)
      bellTimerRef.current = setTimeout(() => setBellFlash(false), 280)
    }
    entry.handlers.onGeometryChange = (cols, rows, isInitial) => {
      if (isInitial || !isVisibleRef.current) return
      setGeometryHud({ cols, rows })
      if (hudTimerRef.current) clearTimeout(hudTimerRef.current)
      hudTimerRef.current = setTimeout(() => setGeometryHud(null), 850)
    }

    const onSearchResults = entry.search.onDidChangeResults(({ resultIndex, resultCount }) => {
      setFindResult({ index: resultIndex, count: resultCount })
    })

    attachXterm(entry, el)

    xtermRef.current = entry.term
    fitRef.current = entry.fit
    searchRef.current = entry.search

    const doFit = () => fitXterm(entry)
    requestAnimationFrame(doFit)
    const settleFitTimer = setTimeout(() => fitXterm(entry, { immediateIpc: true }), 90)

    let resizeRaf: number | null = null
    const observer = new ResizeObserver(() => {
      // Skip ResizeObserver layout work on background tabs; they refit cleanly on becoming visible!
      if (!isVisibleRef.current) return
      if (resizeRaf !== null) cancelAnimationFrame(resizeRaf)
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null
        doFit()
      })
    })
    observer.observe(el)

    return () => {
      clearTimeout(settleFitTimer)
      if (hudTimerRef.current) clearTimeout(hudTimerRef.current)
      if (bellTimerRef.current) clearTimeout(bellTimerRef.current)
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
      if (resizeRaf !== null) cancelAnimationFrame(resizeRaf)
      observer.disconnect()
      onSearchResults.dispose()
      entry.handlers = {}
      // Detach only — the xterm (and its scrollback) survives split/unsplit/zoom remounts.
      // It is disposed by TerminalWorkspaceArea once the terminal leaves the store.
      detachXterm(entry, el)
      xtermRef.current = null
      fitRef.current = null
      searchRef.current = null
    }
  }, [terminalId])

  // Live theme sync
  useEffect(() => {
    const entry = getXterm(terminalId)
    if (entry) {
      entry.term.options.theme = getXtermTheme(theme)
      entry.canvas?.clearTextureAtlas()
    }
  }, [theme, terminalId])

  // Live font size sync (refit PTY rows/cols only when dimensions actually change!)
  useEffect(() => {
    const entry = getXterm(terminalId)
    if (!entry) return
    entry.term.options.fontSize = terminalFontSize
    if (isVisible) {
      requestAnimationFrame(() => fitXterm(entry, { immediateIpc: true }))
    }
  }, [terminalFontSize, isVisible, terminalId])

  // Refit cleanly when becoming visible or toggling pane zoom
  useEffect(() => {
    const entry = getXterm(terminalId)
    if (isVisible && entry) {
      const raf = requestAnimationFrame(() => {
        const resized = fitXterm(entry, { immediateIpc: true })
        if (!resized) {
          entry.term.refresh(0, Math.max(0, entry.term.rows - 1))
        }
      })
      const timer = setTimeout(() => fitXterm(entry, { immediateIpc: true }), 90)
      return () => {
        cancelAnimationFrame(raf)
        clearTimeout(timer)
      }
    }
  }, [isVisible, isZoomed, terminalId])

  // Refit cleanly after SSH transitions to connected or switches tmux sessions so remote cols/rows always match
  useEffect(() => {
    if (connState !== 'connected') return
    const timer = setTimeout(() => {
      const entry = getXterm(terminalId)
      if (entry) fitXterm(entry, { force: true, immediateIpc: true })
    }, 120)
    return () => clearTimeout(timer)
  }, [connState, termStatus?.tmuxSession, terminalId])

  // Close tmux session popover on outside click or Escape
  useEffect(() => {
    if (!showTmuxMenu) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (tmuxMenuRef.current?.contains(target) || tmuxBtnRef.current?.contains(target)) return
      setShowTmuxMenu(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowTmuxMenu(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [showTmuxMenu])

  // Focus xterm cleanly without resizing when focus switches to this pane
  useEffect(() => {
    if (isVisible && isFocused && !showFind && xtermRef.current) {
      requestAnimationFrame(() => xtermRef.current?.focus())
    }
  }, [isVisible, isFocused, showFind, terminalId])

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
    }
  }, [contextMenu])

  const handleDropPath = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const entryRaw = e.dataTransfer.getData('application/x-multiplex-entry')
    if (entryRaw) {
      try {
        const entry = JSON.parse(entryRaw) as { path: string }
        const quoted = `'${entry.path.replace(/'/g, `'\\''`)}' `
        window.multiplex.writeTerminal(terminalId, quoted)
        xtermRef.current?.focus()
        return
      } catch {
        // ignore
      }
    }

    const files = Array.from(e.dataTransfer.files || [])
    if (files.length > 0) {
      const paths = files
        .map((f) => window.multiplex.getPathForFile(f))
        .filter(Boolean)
        .map((p) => `'${p.replace(/'/g, `'\\''`)}'`)
      if (paths.length > 0) {
        window.multiplex.writeTerminal(terminalId, paths.join(' ') + ' ')
        xtermRef.current?.focus()
      }
    }
  }

  const displayTitle = dynamicTitle
    ? env?.kind === 'ssh'
      ? `${env.name} · ${dynamicTitle}`
      : dynamicTitle
    : `${env?.name || envId} — ${title}`

  return (
    <div
      className={`group/pane flex h-full w-full flex-col overflow-hidden ${bellFlash ? 'iterm-bell-flash' : ''}`}
      style={{
        backgroundColor: 'var(--st-terminal)',
        boxShadow:
          paneCount > 1 && isFocused
            ? 'inset 0 0 0 1px rgba(255, 255, 255, 0.11)'
            : undefined
      }}
      onMouseDown={(e) => {
        setFocusedPane(envId, tabId, paneId, terminalId)
        // xterm natively focuses its own textarea on clicks inside `.xterm`; only focus manually
        // when clicking the pane header/frame so text drag-selection & IME are never interrupted!
        if (!(e.target as HTMLElement | null)?.closest?.('.xterm, input, button')) {
          requestAnimationFrame(() => xtermRef.current?.focus())
        }
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDropPath}
    >
      {/* iTerm2-style Minimalist Session Title Bar */}
      <div
        className="flex h-[24px] shrink-0 items-center justify-between px-2.5 border-b text-[11px] transition-colors"
        style={{
          backgroundColor: isFocused ? 'var(--st-panel)' : 'var(--st-tabbar)',
          borderColor: 'var(--st-border)'
        }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={`h-1.5 w-1.5 rounded-full shrink-0 ${connState === 'reconnecting' || connState === 'connecting' ? 'st3-attention-pulse' : ''}`}
            style={{
              backgroundColor:
                connState === 'disconnected'
                  ? 'var(--st-red)'
                  : connState === 'reconnecting' || connState === 'connecting'
                    ? 'var(--st-yellow)'
                    : env?.color || 'var(--st-green)'
            }}
          />
          <span
            className="truncate font-mono"
            style={{ color: isFocused ? 'var(--st-text)' : 'var(--st-text-dim)' }}
            title={displayTitle}
          >
            {displayTitle}
          </span>
          {env?.kind === 'ssh' && env.useTmux && (
            <div className="relative shrink-0">
              <button
                ref={tmuxBtnRef}
                onClick={(e) => {
                  e.stopPropagation()
                  const next = !showTmuxMenu
                  if (next) {
                    const rect = e.currentTarget.getBoundingClientRect()
                    const menuW = 320
                    const menuH = 310
                    const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuW - 8))
                    const top =
                      rect.bottom + menuH < window.innerHeight - 12
                        ? rect.bottom + 4
                        : Math.max(8, rect.top - menuH - 4)
                    setTmuxMenuPos({ left, top })
                    void refreshTmuxList()
                  }
                  setShowTmuxMenu(next)
                }}
                className="flex items-center gap-0.5 rounded px-1.5 py-0 text-[10px] font-mono hover:bg-white/15 transition-colors"
                style={{
                  backgroundColor: showTmuxMenu ? 'rgba(102, 217, 239, 0.2)' : 'rgba(255,255,255,0.06)',
                  color: termStatus?.tmuxSession ? 'var(--st-accent-blue)' : 'var(--st-text-dim)'
                }}
                title={
                  termStatus?.tmuxSession
                    ? `Attached to remote tmux session "${termStatus.tmuxSession}" — click to switch/manage sessions (no need for nested \`tmux a\`)`
                    : 'Manage remote tmux sessions'
                }
              >
                <span>tmux{termStatus?.tmuxSession ? `:${termStatus.tmuxSession.replace(/^mide_/, '')}` : ''}</span>
                <ChevronDown className="h-2.5 w-2.5 opacity-70" />
              </button>

              {showTmuxMenu && (
                <div
                  ref={tmuxMenuRef}
                  onMouseDown={(e) => e.stopPropagation()}
                  className="fixed z-50 w-[320px] rounded-md border shadow-2xl text-[11.5px] select-none"
                  style={{
                    left: tmuxMenuPos.left,
                    top: tmuxMenuPos.top,
                    backgroundColor: 'var(--st-panel)',
                    borderColor: 'var(--st-border-light)',
                    color: 'var(--st-text)'
                  }}
                >
                  <div
                    className="flex items-center justify-between px-2.5 py-1.5 border-b"
                    style={{ borderColor: 'var(--st-border)' }}
                  >
                    <span className="font-semibold text-[11px]" style={{ color: 'var(--st-text-muted)' }}>
                      Remote tmux Sessions ({env.name})
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        void refreshTmuxList()
                      }}
                      title="Refresh remote tmux list"
                      className="rounded p-0.5 hover:bg-white/10"
                      style={{ color: 'var(--st-text-dim)' }}
                    >
                      <RefreshCw className={`h-3 w-3 ${tmuxLoading ? 'animate-spin' : ''}`} />
                    </button>
                  </div>

                  <div className="max-h-[240px] overflow-y-auto py-1">
                    {tmuxLoading && tmuxSessions.length === 0 ? (
                      <div className="px-3 py-2 text-center font-mono text-[11px]" style={{ color: 'var(--st-text-dim)' }}>
                        Loading tmux sessions...
                      </div>
                    ) : tmuxSessions.length === 0 ? (
                      <div className="px-3 py-2 text-center font-mono text-[11px]" style={{ color: 'var(--st-text-dim)' }}>
                        No active remote tmux sessions found
                      </div>
                    ) : (
                      tmuxSessions.map((sess) => {
                        const isCurrent = sess.name === termStatus?.tmuxSession
                        const isActiveApp =
                          sess.command &&
                          !['zsh', 'bash', 'sh', 'fish', 'dash'].includes(sess.command.replace(/^-/, '').toLowerCase())
                        return (
                          <div
                            key={sess.name}
                            onClick={(e) => {
                              e.stopPropagation()
                              setShowTmuxMenu(false)
                              if (!isCurrent) {
                                void switchTerminalTmuxSession(envId, terminalId, sess.name)
                              }
                              xtermRef.current?.focus()
                            }}
                            className="group flex items-center justify-between gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-white/10"
                            style={{
                              backgroundColor: isCurrent ? 'rgba(102, 217, 239, 0.1)' : undefined
                            }}
                            title={`${sess.name} · ${sess.command || 'shell'}${sess.cwd ? ` · ${sess.cwd}` : ''}`}
                          >
                            <div className="flex items-center gap-1.5 min-w-0">
                              {isCurrent ? (
                                <Check className="h-3 w-3 shrink-0" style={{ color: 'var(--st-green)' }} />
                              ) : (
                                <span
                                  className="h-1.5 w-1.5 rounded-full shrink-0 ml-0.5 mr-0.5"
                                  style={{
                                    backgroundColor: isActiveApp
                                      ? 'var(--st-accent)'
                                      : sess.attached > 0
                                        ? 'var(--st-yellow)'
                                        : 'var(--st-text-dim)'
                                  }}
                                />
                              )}
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="truncate font-mono font-medium">{sess.name}</span>
                                  {sess.command && (
                                    <span
                                      className="rounded px-1 text-[9.5px] font-mono shrink-0"
                                      style={{
                                        backgroundColor: isActiveApp
                                          ? 'rgba(166, 226, 46, 0.16)'
                                          : 'rgba(255, 255, 255, 0.08)',
                                        color: isActiveApp ? 'var(--st-green)' : 'var(--st-text-muted)'
                                      }}
                                    >
                                      {sess.command}
                                    </span>
                                  )}
                                </div>
                                <div className="truncate font-mono text-[10px]" style={{ color: 'var(--st-text-dim)' }}>
                                  {formatSessionAge(sess.ageSec)}
                                  {sess.size ? ` · ${sess.size}` : ''}
                                  {isCurrent
                                    ? ' · this pane'
                                    : sess.ownedByApp
                                      ? ' · other tab'
                                      : sess.attached > 0
                                        ? ' · attached'
                                        : ''}
                                </div>
                              </div>
                            </div>

                            {!isCurrent && !sess.ownedByApp && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void killRemoteTmuxSession(envId, sess.name).then(() => refreshTmuxList())
                                }}
                                title={`Kill tmux session ${sess.name}`}
                                className="rounded p-1 opacity-0 group-hover:opacity-100 hover:bg-white/15 shrink-0"
                                style={{ color: 'var(--st-red)' }}
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                        )
                      })
                    )}
                  </div>

                  <div
                    className="flex items-center justify-between gap-1 px-2 py-1.5 border-t text-[11px]"
                    style={{ borderColor: 'var(--st-border)' }}
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setShowTmuxMenu(false)
                        void switchTerminalTmuxSession(envId, terminalId, '__new__')
                        xtermRef.current?.focus()
                      }}
                      className="flex items-center gap-1 rounded px-2 py-0.5 hover:bg-white/10"
                      style={{ color: 'var(--st-accent)' }}
                    >
                      <Plus className="h-3 w-3" />
                      <span>New Session</span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        void pruneStaleTmuxSessions(envId, 3600).then(() => refreshTmuxList())
                      }}
                      title="Kill unattached mide_* sessions idle > 1 hour"
                      className="rounded px-2 py-0.5 hover:bg-white/10"
                      style={{ color: 'var(--st-text-dim)' }}
                    >
                      Clean &gt;1h
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {isZoomed && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                toggleZoomPane(tabId, paneId)
              }}
              className="rounded px-1.5 py-0 text-[10px] font-mono shrink-0 hover:brightness-110"
              style={{ backgroundColor: 'rgba(249, 174, 88, 0.18)', color: 'var(--st-dirty)' }}
              title="Click or press ⌘⇧⏎ to restore all split panes"
            >
              Zoomed · ⌘⇧⏎
            </button>
          )}
          {copiedBadge && (
            <span
              className="rounded px-1.5 py-0 text-[10px] font-mono shrink-0"
              style={{ backgroundColor: 'rgba(166, 226, 46, 0.16)', color: 'var(--st-green)' }}
            >
              Copied
            </span>
          )}
          {connState === 'reconnecting' && (
            <span className="font-mono text-[10.5px] shrink-0" style={{ color: 'var(--st-yellow)' }}>
              {termStatus?.message || 'Reconnecting...'}
            </span>
          )}
          {connState === 'disconnected' && (
            <span className="font-mono text-[10.5px] shrink-0" style={{ color: 'var(--st-red)' }}>
              Disconnected
            </span>
          )}
        </div>

        {/* Calm hover/focus-revealed pane controls */}
        <div
          className={`flex items-center gap-0.5 transition-opacity ${
            isFocused ? 'opacity-85 hover:opacity-100' : 'opacity-35 group-hover/pane:opacity-85'
          }`}
        >
          {env?.kind === 'ssh' && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                void reconnectTerminal(terminalId, true)
                xtermRef.current?.focus()
              }}
              title="Reconnect SSH in-place (preserves scrollback & re-attaches tmux)"
              className="rounded p-0.5 hover:bg-white/10"
              style={{
                color: connState === 'disconnected' ? 'var(--st-accent)' : 'var(--st-text-dim)'
              }}
            >
              <RotateCw className={`h-3 w-3 ${connState === 'reconnecting' ? 'animate-spin' : ''}`} />
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation()
              if (showFind) closeFind()
              else {
                setShowFind(true)
                requestAnimationFrame(() => findInputRef.current?.focus())
              }
            }}
            title="Find in Terminal (⌘F)"
            className="rounded p-0.5 hover:bg-white/10"
            style={{ color: showFind ? 'var(--st-accent)' : 'var(--st-text-dim)' }}
          >
            <Search className="h-3 w-3" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              setFocusedPane(envId, tabId, paneId, terminalId)
              void splitTerminal(envId, 'horizontal')
            }}
            title="Split Right (⌘D or ⌘\)"
            className="rounded p-0.5 hover:bg-white/10"
            style={{ color: 'var(--st-text-dim)' }}
          >
            <Columns2 className="h-3 w-3" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              setFocusedPane(envId, tabId, paneId, terminalId)
              void splitTerminal(envId, 'vertical')
            }}
            title="Split Down (⌘⇧D or ⌘⇧\)"
            className="rounded p-0.5 hover:bg-white/10"
            style={{ color: 'var(--st-text-dim)' }}
          >
            <Rows2 className="h-3 w-3" />
          </button>
          {paneCount > 1 && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                toggleZoomPane(tabId, paneId)
              }}
              title={isZoomed ? 'Restore Split Panes (⌘⇧⏎)' : 'Zoom Pane (⌘⇧⏎)'}
              className="rounded p-0.5 hover:bg-white/10"
              style={{ color: isZoomed ? 'var(--st-dirty)' : 'var(--st-text-dim)' }}
            >
              {isZoomed ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation()
              void closeTerminal(envId, terminalId)
            }}
            title="Close Pane (⌘W)"
            className="rounded p-0.5 hover:bg-white/10"
            style={{ color: 'var(--st-text-dim)' }}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Non-destructive cmux-style reconnect banner */}
      {env?.kind === 'ssh' && (connState === 'disconnected' || connState === 'reconnecting') && (
        <div
          className="flex items-center justify-between gap-2 px-3 py-1.5 border-b text-[12px]"
          style={{
            backgroundColor: connState === 'reconnecting' ? 'rgba(230, 219, 116, 0.1)' : 'rgba(249, 38, 114, 0.12)',
            borderColor: 'var(--st-border)'
          }}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <WifiOff
              className="h-3.5 w-3.5 shrink-0"
              style={{ color: connState === 'reconnecting' ? 'var(--st-yellow)' : 'var(--st-red)' }}
            />
            <span className="truncate font-mono text-[11.5px]" style={{ color: 'var(--st-text)' }}>
              {termStatus?.message || (connState === 'reconnecting' ? 'Reconnecting...' : 'SSH Disconnected')}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {connState === 'reconnecting' && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  void pauseTerminalReconnect(terminalId)
                }}
                className="rounded-sm border px-2 py-0.5 text-[11px] hover:bg-white/10"
                style={{ borderColor: 'var(--st-border-light)', color: 'var(--st-text-muted)' }}
                title="Pause automatic reconnect retries"
              >
                Pause
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation()
                void reconnectTerminal(terminalId, true)
                xtermRef.current?.focus()
              }}
              className="rounded-sm px-2.5 py-0.5 text-[11.5px] font-medium text-[#111]"
              style={{ backgroundColor: 'var(--st-accent)' }}
            >
              Reconnect Now
            </button>
          </div>
        </div>
      )}

      {/* Viewport Wrapper (owns outer padding + floating iTerm2 overlays so `.xterm` has 0px IME offset!) */}
      <div className="relative flex-1 min-h-0 w-full overflow-hidden">
        <div
          ref={containerRef}
          className="h-full w-full overflow-hidden box-border"
          style={{
            padding: '7px 10px 6px 10px',
            contain: 'strict',
            opacity: shouldDim ? 0.76 : 1,
            transition: 'opacity 140ms ease'
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setFocusedPane(envId, tabId, paneId, terminalId)
            setContextMenu({ x: e.clientX, y: e.clientY })
          }}
        />

        {/* iTerm2 Floating Translucent Find Overlay (ZERO layout reflow / ZERO SIGWINCH!) */}
        {showFind && (
          <div
            onMouseDown={(e) => e.stopPropagation()}
            className="absolute top-2 right-3 z-30 flex items-center gap-1 rounded-md border px-2 py-1 shadow-2xl text-[12px]"
            style={{
              backgroundColor: 'rgba(24, 25, 21, 0.92)',
              borderColor: 'var(--st-border-light)',
              backdropFilter: 'blur(14px)'
            }}
          >
            <Search className="h-3.5 w-3.5 shrink-0 opacity-55" />
            <input
              ref={findInputRef}
              autoFocus
              value={findText}
              onChange={(e) => {
                const v = e.target.value
                setFindText(v)
                runSearch(v, 'next', { incremental: true })
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  runSearch(findText, e.shiftKey ? 'prev' : 'next')
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  closeFind()
                }
              }}
              placeholder="Find..."
              className="w-[170px] bg-transparent px-1 py-0.5 font-mono text-[12px] outline-none"
              style={{ color: 'var(--st-text)' }}
            />
            {findText && (
              <span
                className="font-mono text-[10.5px] px-1 shrink-0 tabular-nums"
                style={{
                  color:
                    findResult && findResult.count === 0
                      ? 'var(--st-red)'
                      : 'var(--st-text-muted)'
                }}
              >
                {findResult
                  ? findResult.count === 0
                    ? '0/0'
                    : findResult.index >= 0
                      ? `${findResult.index + 1}/${findResult.count}`
                      : `${findResult.count}`
                  : ''}
              </span>
            )}
            <button
              onClick={() => {
                const next = !findCase
                setFindCase(next)
                if (findText) runSearch(findText, 'next', { caseSensitive: next })
              }}
              title="Match Case"
              className="rounded px-1 py-0.5 font-mono text-[10.5px] transition-colors"
              style={{
                backgroundColor: findCase ? 'rgba(255,255,255,0.16)' : 'transparent',
                color: findCase ? 'var(--st-accent)' : 'var(--st-text-dim)'
              }}
            >
              Aa
            </button>
            <button
              onClick={() => {
                const next = !findRegex
                setFindRegex(next)
                if (findText) runSearch(findText, 'next', { regex: next })
              }}
              title="Regular Expression"
              className="rounded px-1 py-0.5 font-mono text-[10.5px] transition-colors"
              style={{
                backgroundColor: findRegex ? 'rgba(255,255,255,0.16)' : 'transparent',
                color: findRegex ? 'var(--st-accent)' : 'var(--st-text-dim)'
              }}
            >
              .*
            </button>
            <button
              onClick={() => runSearch(findText, 'prev')}
              title="Previous Match (⇧⏎)"
              className="rounded p-0.5 hover:bg-white/10"
              style={{ color: 'var(--st-text-muted)' }}
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => runSearch(findText, 'next')}
              title="Next Match (⏎)"
              className="rounded p-0.5 hover:bg-white/10"
              style={{ color: 'var(--st-text-muted)' }}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={closeFind}
              title="Close Find (Esc)"
              className="rounded p-0.5 hover:bg-white/10"
              style={{ color: 'var(--st-text-dim)' }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* iTerm2 Multi-Line Paste Safety Guard (only when bracketed paste mode is OFF) */}
        {pendingPaste && (
          <div
            onMouseDown={(e) => e.stopPropagation()}
            className="absolute top-2 left-3 right-3 z-30 flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 shadow-2xl text-[11.5px]"
            style={{
              backgroundColor: 'rgba(30, 26, 18, 0.95)',
              borderColor: 'rgba(249, 174, 88, 0.45)',
              backdropFilter: 'blur(12px)'
            }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--st-dirty)' }} />
              <span className="truncate font-mono" style={{ color: 'var(--st-text)' }}>
                Paste {pendingPaste.lineCount} lines? (Bracketed paste off — newlines execute immediately)
              </span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={() => {
                  const raw = pendingPaste.text
                  setPendingPaste(null)
                  pasteIntoTerminal(terminalId, raw, { force: true })
                }}
                className="rounded px-2 py-0.5 text-[11px] font-medium text-[#111]"
                style={{ backgroundColor: 'var(--st-dirty)' }}
              >
                Paste
              </button>
              <button
                onClick={() => {
                  const single = flattenPasteToSingleLine(pendingPaste.text)
                  setPendingPaste(null)
                  pasteIntoTerminal(terminalId, single, { force: true })
                }}
                className="rounded border px-2 py-0.5 text-[11px] hover:bg-white/10"
                style={{ borderColor: 'var(--st-border-light)', color: 'var(--st-text)' }}
              >
                As 1 Line
              </button>
              <button
                onClick={() => {
                  setPendingPaste(null)
                  xtermRef.current?.focus()
                }}
                className="rounded px-1.5 py-0.5 text-[11px] hover:bg-white/10"
                style={{ color: 'var(--st-text-dim)' }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* iTerm2 Resize Geometry HUD (`142 × 38`) */}
        {geometryHud && !showFind && !pendingPaste && (
          <div
            className="pointer-events-none absolute top-2 right-3 z-20 rounded-md border px-2 py-0.5 font-mono text-[11px] tabular-nums shadow-lg"
            style={{
              backgroundColor: 'rgba(20, 21, 18, 0.84)',
              borderColor: 'rgba(255, 255, 255, 0.14)',
              color: 'var(--st-text)',
              backdropFilter: 'blur(10px)'
            }}
          >
            {geometryHud.cols} × {geometryHud.rows}
          </div>
        )}

        {/* iTerm2 Floating "Scroll to Bottom" Pill */}
        {isScrolledUp && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              xtermRef.current?.scrollToBottom()
              xtermRef.current?.focus()
              setIsScrolledUp(false)
            }}
            className="absolute bottom-3 right-4 z-20 flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium shadow-xl hover:brightness-110 transition-all"
            style={{
              backgroundColor: 'rgba(24, 25, 21, 0.9)',
              borderColor: 'var(--st-border-light)',
              color: 'var(--st-text)',
              backdropFilter: 'blur(10px)'
            }}
            title="Jump to live output"
          >
            <ArrowDown className="h-3 w-3" style={{ color: 'var(--st-accent)' }} />
            <span>Bottom</span>
          </button>
        )}

        {/* iTerm2 Cmd+Click URL Hover Hint */}
        {hoverLink && (
          <div
            className="pointer-events-none absolute bottom-2.5 left-3 z-20 max-w-[70%] truncate rounded border px-2 py-0.5 font-mono text-[10.5px] shadow-lg"
            style={{
              backgroundColor: 'rgba(20, 21, 18, 0.88)',
              borderColor: 'rgba(255, 255, 255, 0.12)',
              color: 'var(--st-text-muted)',
              backdropFilter: 'blur(8px)'
            }}
          >
            <span style={{ color: 'var(--st-accent)' }}>⌘+Click</span> {hoverLink}
          </div>
        )}
      </div>

      {/* Native-feeling iTerm2 Context Menu */}
      {contextMenu && (
        <div
          className="fixed z-50 min-w-[205px] rounded-md border py-1 shadow-2xl text-[12px] select-none"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 220),
            top: Math.min(contextMenu.y, window.innerHeight - 310),
            backgroundColor: 'var(--st-panel)',
            borderColor: 'var(--st-border-light)',
            color: 'var(--st-text)',
            backdropFilter: 'blur(14px)'
          }}
        >
          <button
            onClick={() => {
              const sel = xtermRef.current?.getSelection()
              if (sel) window.multiplex.writeClipboardText(sel)
              xtermRef.current?.focus()
              setContextMenu(null)
            }}
            disabled={!xtermRef.current?.hasSelection()}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-white/10 disabled:opacity-40"
          >
            <span>Copy</span>
            <span className="font-mono text-[11px] opacity-60">⌘C</span>
          </button>
          <button
            onClick={() => {
              const text = window.multiplex.readClipboardText()
              if (text) pasteIntoTerminal(terminalId, text)
              setContextMenu(null)
            }}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-white/10"
          >
            <span>Paste</span>
            <span className="font-mono text-[11px] opacity-60">⌘V</span>
          </button>
          <button
            onClick={() => {
              xtermRef.current?.selectAll()
              xtermRef.current?.focus()
              setContextMenu(null)
            }}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-white/10"
          >
            <span>Select All</span>
            <span className="font-mono text-[11px] opacity-60">⌘A</span>
          </button>
          <button
            onClick={() => {
              setShowFind(true)
              setContextMenu(null)
              requestAnimationFrame(() => findInputRef.current?.focus())
            }}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-white/10"
          >
            <span>Find...</span>
            <span className="font-mono text-[11px] opacity-60">⌘F</span>
          </button>
          <button
            onClick={() => {
              xtermRef.current?.clear()
              xtermRef.current?.focus()
              setContextMenu(null)
            }}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-white/10"
          >
            <span>Clear Buffer</span>
            <span className="font-mono text-[11px] opacity-60">⌘K</span>
          </button>
          <div className="my-1 border-t" style={{ borderColor: 'var(--st-border)' }} />
          <button
            onClick={() => {
              setFocusedPane(envId, tabId, paneId, terminalId)
              void splitTerminal(envId, 'horizontal')
              setContextMenu(null)
            }}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-white/10"
          >
            <span>Split Vertically</span>
            <span className="font-mono text-[11px] opacity-60">⌘D</span>
          </button>
          <button
            onClick={() => {
              setFocusedPane(envId, tabId, paneId, terminalId)
              void splitTerminal(envId, 'vertical')
              setContextMenu(null)
            }}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-white/10"
          >
            <span>Split Horizontally</span>
            <span className="font-mono text-[11px] opacity-60">⌘⇧D</span>
          </button>
          {paneCount > 1 && (
            <button
              onClick={() => {
                toggleZoomPane(tabId, paneId)
                setContextMenu(null)
              }}
              className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-white/10"
            >
              <span>{isZoomed ? 'Restore Split Panes' : 'Zoom Active Pane'}</span>
              <span className="font-mono text-[11px] opacity-60">⌘⇧⏎</span>
            </button>
          )}
          <div className="my-1 border-t" style={{ borderColor: 'var(--st-border)' }} />
          <button
            onClick={() => {
              updateTerminalPrefs({ copyOnSelect: !terminalPrefs.copyOnSelect })
              xtermRef.current?.focus()
              setContextMenu(null)
            }}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-white/10"
          >
            <span>Copy on Select</span>
            {terminalPrefs.copyOnSelect && <Check className="h-3.5 w-3.5" style={{ color: 'var(--st-accent)' }} />}
          </button>
        </div>
      )}
    </div>
  )
}
