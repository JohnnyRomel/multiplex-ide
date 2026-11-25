import React, { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Columns2, RotateCw, Rows2, Search, WifiOff, X } from 'lucide-react'
import type { EditorThemeId } from '@shared/types'
import { useAppStore } from '@renderer/stores/useAppStore'

function getXtermTheme(theme: EditorThemeId) {
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
  const termStatus = useAppStore((s) => s.terminalStatuses[terminalId])
  const env = useAppStore((s) => s.environments.find((e) => e.id === envId))

  const [showFind, setShowFind] = useState(false)
  const [findText, setFindText] = useState('')
  const isFocused = focusedTerminalId === terminalId
  const connState = termStatus?.state || (env?.kind === 'local' ? 'connected' : 'connecting')

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const initState = useAppStore.getState()
    const term = new XTerm({
      fontFamily: 'Menlo, "SF Mono", "JetBrains Mono", Monaco, monospace',
      fontSize: initState.terminalFontSize,
      lineHeight: 1.28,
      cursorBlink: true,
      cursorStyle: 'block',
      macOptionIsMeta: true,
      scrollback: 15000,
      theme: getXtermTheme(initState.theme)
    })

    const fitAddon = new FitAddon()
    const searchAddon = new SearchAddon()
    const webLinksAddon = new WebLinksAddon()

    term.loadAddon(fitAddon)
    term.loadAddon(searchAddon)
    term.loadAddon(webLinksAddon)
    term.open(el)

    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // fallback safely to Canvas/DOM
    }

    xtermRef.current = term
    fitRef.current = fitAddon
    searchRef.current = searchAddon

    const doFit = () => {
      if (!el.offsetWidth || !el.offsetHeight) return
      try {
        fitAddon.fit()
        window.multiplex.resizeTerminal(terminalId, term.cols, term.rows)
      } catch {
        // ignore layout race
      }
    }

    requestAnimationFrame(doFit)

    const onDataDisposable = term.onData((data) => {
      window.multiplex.writeTerminal(terminalId, data)
    })

    const offIpcData = window.multiplex.onTerminalData((id, data) => {
      if (id === terminalId) {
        term.write(data)
      }
    })

    const observer = new ResizeObserver(() => {
      requestAnimationFrame(doFit)
    })
    observer.observe(el)

    // Pass app-level Cmd shortcuts through to window listener cleanly!
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type === 'keydown' && ev.metaKey) {
        const k = ev.key.toLowerCase()
        if (!ev.shiftKey && !ev.altKey && k === 'f') {
          setShowFind((v) => !v)
          return false
        }
        if (!ev.shiftKey && !ev.altKey && k === 'k') {
          term.clear()
          return false
        }
        if (
          k === 'p' ||
          k === 't' ||
          k === 'w' ||
          (ev.shiftKey && k === 'f') ||
          k === 'b' ||
          k === 'j' ||
          k === ',' ||
          k === 's' ||
          k === '=' ||
          k === '+' ||
          k === '-' ||
          k === '0' ||
          k === '[' ||
          k === ']' ||
          ev.code === 'Backslash' ||
          (k >= '1' && k <= '9')
        ) {
          return false
        }
      }
      return true
    })

    return () => {
      observer.disconnect()
      onDataDisposable.dispose()
      offIpcData()
      term.dispose()
      xtermRef.current = null
    }
  }, [terminalId])

  // Live theme sync
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = getXtermTheme(theme)
    }
  }, [theme])

  // Live font size sync (refit PTY rows/cols immediately!)
  useEffect(() => {
    const term = xtermRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    term.options.fontSize = terminalFontSize
    if (isVisible) {
      requestAnimationFrame(() => {
        try {
          fit.fit()
          window.multiplex.resizeTerminal(terminalId, term.cols, term.rows)
        } catch {
          // ignore
        }
      })
    }
  }, [terminalFontSize, isVisible, terminalId])

  useEffect(() => {
    if (isVisible && fitRef.current && xtermRef.current) {
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit()
          window.multiplex.resizeTerminal(terminalId, xtermRef.current!.cols, xtermRef.current!.rows)
          if (isFocused) xtermRef.current?.focus()
        } catch {
          // ignore
        }
      })
    }
  }, [isVisible, isFocused, terminalId])

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
      onMouseDown={() => setFocusedPane(envId, tabId, paneId, terminalId)}
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
          {termStatus?.tmuxSession && (
            <span
              className="rounded px-1 text-[10px] font-mono shrink-0"
              style={{ backgroundColor: 'rgba(255,255,255,0.06)', color: 'var(--st-text-dim)' }}
              title={`Persistent remote tmux session: ${termStatus.tmuxSession}`}
            >
              tmux
            </span>
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
          <button
            onClick={(e) => {
              e.stopPropagation()
              void reconnectTerminal(terminalId, true)
              xtermRef.current?.focus()
            }}
            className="shrink-0 rounded-sm px-2.5 py-0.5 text-[11.5px] font-medium text-[#111]"
            style={{ backgroundColor: 'var(--st-accent)' }}
          >
            Reconnect Now
          </button>
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

      <div ref={containerRef} className="flex-1 min-h-0 w-full overflow-hidden" />
    </div>
  )
}
