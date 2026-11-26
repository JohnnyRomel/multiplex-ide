import React, { useEffect, useRef, useState } from 'react'
import type { Terminal as XTerm } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { SearchAddon } from '@xterm/addon-search'
import { Check, ChevronDown, Columns2, Plus, RefreshCw, RotateCw, Rows2, Search, Trash2, WifiOff, X } from 'lucide-react'
import type { EditorThemeId, RecoverableTmuxSession } from '@shared/types'
import { useAppStore } from '@renderer/stores/useAppStore'
import { attachXterm, detachXterm, fitXterm, getOrCreateXterm, getXterm } from './xtermRegistry'

export function getXtermTheme(theme: EditorThemeId) {
  if (theme === 'mariana') {
    return {
      background: '#272e36',
      foreground: '#d8dee9',
      cursor: '#f9ae58',
      selectionBackground: '#4e5a65',
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
      selectionBackground: '#3e4451',
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
    selectionBackground: '#49483e',
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
}

export const TerminalInstance: React.FC<Props> = ({ envId, tabId, paneId, terminalId, title, isVisible }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)

  const theme = useAppStore((s) => s.theme)
  const terminalFontSize = useAppStore((s) => s.terminalFontSize)
  const focusedTerminalId = useAppStore((s) => s.focusedTerminalId)
  const setFocusedPane = useAppStore((s) => s.setFocusedPane)
  const splitTerminal = useAppStore((s) => s.splitTerminal)
  const closeTerminal = useAppStore((s) => s.closeTerminal)
  const reconnectTerminal = useAppStore((s) => s.reconnectTerminal)
  const pauseTerminalReconnect = useAppStore((s) => s.pauseTerminalReconnect)
  const switchTerminalTmuxSession = useAppStore((s) => s.switchTerminalTmuxSession)
  const listRemoteTmuxSessions = useAppStore((s) => s.listRemoteTmuxSessions)
  const killRemoteTmuxSession = useAppStore((s) => s.killRemoteTmuxSession)
  const pruneStaleTmuxSessions = useAppStore((s) => s.pruneStaleTmuxSessions)
  const termStatus = useAppStore((s) => s.terminalStatuses[terminalId])
  const env = useAppStore((s) => s.environments.find((e) => e.id === envId))

  const [showFind, setShowFind] = useState(false)
  const [findText, setFindText] = useState('')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [showTmuxMenu, setShowTmuxMenu] = useState(false)
  const [tmuxMenuPos, setTmuxMenuPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 })
  const [tmuxSessions, setTmuxSessions] = useState<RecoverableTmuxSession[]>([])
  const [tmuxLoading, setTmuxLoading] = useState(false)
  const tmuxMenuRef = useRef<HTMLDivElement>(null)
  const tmuxBtnRef = useRef<HTMLButtonElement>(null)
  const isFocused = focusedTerminalId === terminalId
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

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const initState = useAppStore.getState()
    const entry = getOrCreateXterm(terminalId, {
      fontSize: initState.terminalFontSize,
      theme: getXtermTheme(initState.theme)
    })
    entry.handlers.onToggleFind = () => setShowFind((v) => !v)
    attachXterm(entry, el)

    xtermRef.current = entry.term
    fitRef.current = entry.fit
    searchRef.current = entry.search

    const doFit = () => fitXterm(entry)
    requestAnimationFrame(doFit)
    const settleFitTimer = setTimeout(doFit, 90)

    let resizeRaf: number | null = null
    const observer = new ResizeObserver(() => {
      if (resizeRaf !== null) cancelAnimationFrame(resizeRaf)
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null
        doFit()
      })
    })
    observer.observe(el)

    return () => {
      clearTimeout(settleFitTimer)
      if (resizeRaf !== null) cancelAnimationFrame(resizeRaf)
      observer.disconnect()
      if (entry.handlers.onToggleFind) entry.handlers.onToggleFind = undefined
      // Detach only — the xterm (and its scrollback) survives split/unsplit remounts.
      // It is disposed by TerminalWorkspaceArea once the terminal leaves the store.
      detachXterm(entry, el)
      xtermRef.current = null
      fitRef.current = null
      searchRef.current = null
    }
  }, [terminalId])

  // Live theme sync
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = getXtermTheme(theme)
    }
  }, [theme])

  // Live font size sync (refit PTY rows/cols only when dimensions actually change!)
  useEffect(() => {
    const entry = getXterm(terminalId)
    if (!entry) return
    entry.term.options.fontSize = terminalFontSize
    if (isVisible) {
      requestAnimationFrame(() => fitXterm(entry))
    }
  }, [terminalFontSize, isVisible, terminalId])

  // Refit ONLY when becoming visible (never trigger redundant SIGWINCH on focus clicks!)
  useEffect(() => {
    const entry = getXterm(terminalId)
    if (isVisible && entry) {
      const syncFit = () => fitXterm(entry)
      requestAnimationFrame(syncFit)
      const timer = setTimeout(syncFit, 80)
      return () => clearTimeout(timer)
    }
  }, [isVisible, terminalId])

  // Refit cleanly after SSH transitions to connected or switches tmux sessions so remote cols/rows always match
  useEffect(() => {
    if (connState !== 'connected') return
    const timer = setTimeout(() => {
      const entry = getXterm(terminalId)
      if (entry) fitXterm(entry, true)
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
    if (isVisible && isFocused && xtermRef.current) {
      requestAnimationFrame(() => xtermRef.current?.focus())
    }
  }, [isVisible, isFocused, terminalId])

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

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden"
      style={{
        backgroundColor: 'var(--st-terminal)',
        outline: isFocused ? '1px solid rgba(255,255,255,0.08)' : 'none',
        outlineOffset: '-1px'
      }}
      onMouseDown={() => {
        setFocusedPane(envId, tabId, paneId, terminalId)
        requestAnimationFrame(() => xtermRef.current?.focus())
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDropPath}
    >
      {/* Compact pane sub-header */}
      <div
        className="flex h-[25px] shrink-0 items-center justify-between px-2.5 border-b text-[11.5px]"
        style={{ backgroundColor: 'var(--st-panel)', borderColor: 'var(--st-border)' }}
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
          >
            {env?.name || envId} — {title}
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
                  backgroundColor: showTmuxMenu ? 'rgba(102, 217, 239, 0.2)' : 'rgba(255,255,255,0.07)',
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
                  className="fixed z-50 w-[320px] rounded border shadow-2xl text-[11.5px] select-none"
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
                                  {isCurrent ? ' · this pane' : sess.ownedByApp ? ' · other tab' : sess.attached > 0 ? ' · attached' : ''}
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
          {connState === 'reconnecting' && (
            <span className="font-mono text-[11px] shrink-0" style={{ color: 'var(--st-yellow)' }}>
              {termStatus?.message || 'Reconnecting...'}
            </span>
          )}
          {connState === 'disconnected' && (
            <span className="font-mono text-[11px] shrink-0" style={{ color: 'var(--st-red)' }}>
              Disconnected
            </span>
          )}
        </div>

        <div className="flex items-center gap-0.5">
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
              <RotateCw className={`h-3.5 w-3.5 ${connState === 'reconnecting' ? 'animate-spin' : ''}`} />
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation()
              setShowFind((v) => !v)
            }}
            title="Find in Terminal (⌘F)"
            className="rounded p-0.5 hover:bg-white/10"
            style={{ color: 'var(--st-text-dim)' }}
          >
            <Search className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              setFocusedPane(envId, tabId, paneId, terminalId)
              void splitTerminal(envId, 'horizontal')
            }}
            title="Split Right (⌘\)"
            className="rounded p-0.5 hover:bg-white/10"
            style={{ color: 'var(--st-text-dim)' }}
          >
            <Columns2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              setFocusedPane(envId, tabId, paneId, terminalId)
              void splitTerminal(envId, 'vertical')
            }}
            title="Split Down (⌘⇧\)"
            className="rounded p-0.5 hover:bg-white/10"
            style={{ color: 'var(--st-text-dim)' }}
          >
            <Rows2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              void closeTerminal(envId, terminalId)
            }}
            title="Close Pane"
            className="rounded p-0.5 hover:bg-white/10"
            style={{ color: 'var(--st-text-dim)' }}
          >
            <X className="h-3.5 w-3.5" />
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

      {showFind && (
        <div
          className="flex items-center gap-1.5 px-2.5 py-1 border-b text-[12px]"
          style={{ backgroundColor: 'var(--st-panel)', borderColor: 'var(--st-border)' }}
        >
          <input
            autoFocus
            value={findText}
            onChange={(e) => {
              setFindText(e.target.value)
              searchRef.current?.findNext(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (e.shiftKey) searchRef.current?.findPrevious(findText)
                else searchRef.current?.findNext(findText)
              } else if (e.key === 'Escape') {
                setShowFind(false)
                xtermRef.current?.focus()
              }
            }}
            placeholder="Find in terminal..."
            className="flex-1 rounded px-2 py-0.5 font-mono text-[12px] outline-none border"
            style={{ backgroundColor: 'var(--st-input)', borderColor: 'var(--st-border-light)' }}
          />
          <button onClick={() => setShowFind(false)} className="rounded p-0.5 hover:bg-white/10">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div
        ref={containerRef}
        className="flex-1 min-h-0 w-full overflow-hidden"
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setFocusedPane(envId, tabId, paneId, terminalId)
          setContextMenu({ x: e.clientX, y: e.clientY })
        }}
      />

      {contextMenu && (
        <div
          className="fixed z-50 min-w-[185px] rounded border py-1 shadow-2xl text-[12.5px] select-none"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 200),
            top: Math.min(contextMenu.y, window.innerHeight - 230),
            backgroundColor: 'var(--st-panel)',
            borderColor: 'var(--st-border-light)',
            color: 'var(--st-text)'
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
              if (text) xtermRef.current?.paste(text)
              xtermRef.current?.focus()
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
              xtermRef.current?.clear()
              xtermRef.current?.focus()
              setContextMenu(null)
            }}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-white/10"
          >
            <span>Clear Terminal</span>
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
            <span>Split Right</span>
            <span className="font-mono text-[11px] opacity-60">⌘\</span>
          </button>
          <button
            onClick={() => {
              setFocusedPane(envId, tabId, paneId, terminalId)
              void splitTerminal(envId, 'vertical')
              setContextMenu(null)
            }}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-white/10"
          >
            <span>Split Down</span>
            <span className="font-mono text-[11px] opacity-60">⌘⇧\</span>
          </button>
        </div>
      )}
    </div>
  )
}
