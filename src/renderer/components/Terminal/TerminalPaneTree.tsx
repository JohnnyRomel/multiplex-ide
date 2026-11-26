import React, { useEffect, useRef, useState } from 'react'
import { Allotment } from 'allotment'
import {
  Check,
  Columns2,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  RotateCw,
  Rows2,
  SlidersHorizontal,
  Terminal,
  X
} from 'lucide-react'
import {
  collectEnvTerminalIds,
  collectLeafNodes,
  collectTerminalIds,
  type TerminalSplitNode,
  useAppStore
} from '@renderer/stores/useAppStore'
import { TerminalInstance } from './TerminalInstance'
import { applyTerminalPrefsToAll, pruneXterms } from './xtermRegistry'

const RecursiveSplit: React.FC<{
  envId: string
  tabId: string
  node: TerminalSplitNode
  isVisible: boolean
  paneCount: number
}> = ({ envId, tabId, node, isVisible, paneCount }) => {
  if (node.type === 'leaf') {
    return (
      <TerminalInstance
        envId={envId}
        tabId={tabId}
        paneId={node.paneId}
        terminalId={node.terminalId}
        title={node.title}
        isVisible={isVisible}
        paneCount={paneCount}
        isZoomed={false}
      />
    )
  }

  return (
    <Allotment vertical={node.direction === 'vertical'} proportionalLayout>
      {node.children.map((child) => (
        <Allotment.Pane key={child.type === 'leaf' ? child.paneId : child.id} minSize={120}>
          <RecursiveSplit
            envId={envId}
            tabId={tabId}
            node={child}
            isVisible={isVisible}
            paneCount={paneCount}
          />
        </Allotment.Pane>
      ))}
    </Allotment>
  )
}

export const TerminalWorkspaceArea: React.FC = () => {
  const environments = useAppStore((s) => s.environments)
  const activeEnvId = useAppStore((s) => s.activeEnvId)
  const layoutMode = useAppStore((s) => s.layoutMode)
  const terminalFontSize = useAppStore((s) => s.terminalFontSize)
  const terminalTabsByEnv = useAppStore((s) => s.terminalTabsByEnv)
  const activeTerminalTabByEnv = useAppStore((s) => s.activeTerminalTabByEnv)
  const terminalStatuses = useAppStore((s) => s.terminalStatuses)
  const terminalPrefs = useAppStore((s) => s.terminalPrefs)
  const zoomedPaneByTab = useAppStore((s) => s.zoomedPaneByTab)

  const createTerminalTab = useAppStore((s) => s.createTerminalTab)
  const setActiveTerminalTab = useAppStore((s) => s.setActiveTerminalTab)
  const renameTerminalTab = useAppStore((s) => s.renameTerminalTab)
  const closeTerminalTab = useAppStore((s) => s.closeTerminalTab)
  const splitTerminal = useAppStore((s) => s.splitTerminal)
  const reconnectAllTerminals = useAppStore((s) => s.reconnectAllTerminals)
  const setLayoutMode = useAppStore((s) => s.setLayoutMode)
  const updateTerminalPrefs = useAppStore((s) => s.updateTerminalPrefs)
  const setFontSizes = useAppStore((s) => s.setFontSizes)

  const [editingTabId, setEditingTabId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [showPrefs, setShowPrefs] = useState(false)
  const [prefsPos, setPrefsPos] = useState<{ right: number; top: number }>({ right: 12, top: 44 })
  const prefsRef = useRef<HTMLDivElement>(null)
  const prefsBtnRef = useRef<HTMLButtonElement>(null)

  // Apply iTerm2 terminal preferences live across every persistent xterm instance
  useEffect(() => {
    applyTerminalPrefsToAll(terminalPrefs)
  }, [terminalPrefs])

  // Close preferences popover on outside click or Escape
  useEffect(() => {
    if (!showPrefs) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (prefsRef.current?.contains(target) || prefsBtnRef.current?.contains(target)) return
      setShowPrefs(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowPrefs(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [showPrefs])

  // Dispose persistent xterm instances only once their terminal is gone from every tab/env.
  // (Deferred a tick so an unmount/remount during a split/zoom re-parents instead of disposing.)
  useEffect(() => {
    const timer = setTimeout(() => {
      const live = new Set<string>()
      for (const tabs of Object.values(useAppStore.getState().terminalTabsByEnv)) {
        for (const id of collectEnvTerminalIds(tabs)) live.add(id)
      }
      pruneXterms(live)
    }, 0)
    return () => clearTimeout(timer)
  }, [terminalTabsByEnv])

  const activeEnv = environments.find((e) => e.id === activeEnvId)
  const activeEnvTabs = terminalTabsByEnv[activeEnvId] || []
  const activeTabId = activeTerminalTabByEnv[activeEnvId] || activeEnvTabs[0]?.id
  const allEnvTermIds = collectEnvTerminalIds(activeEnvTabs)
  const hasDisconnectedInEnv =
    activeEnv?.kind === 'ssh' &&
    allEnvTermIds.some((tid) => {
      const st = terminalStatuses[tid]?.state
      return st === 'disconnected' || st === 'reconnecting'
    })

  const commitRename = (tabId: string) => {
    if (editingTitle.trim()) {
      renameTerminalTab(activeEnvId, tabId, editingTitle)
    }
    setEditingTabId(null)
  }

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden"
      style={{ backgroundColor: 'var(--st-terminal)' }}
    >
      {/* iTerm2-style Minimalist Multi-Tab Terminal Bar */}
      <div
        className="flex h-[30px] shrink-0 items-end justify-between border-b pr-1.5"
        style={{ backgroundColor: 'var(--st-tabbar)', borderColor: 'var(--st-border)' }}
      >
        {/* Left: Scrollable Terminal Tabs + Compact New Tab (`+`) button */}
        <div className="flex h-full flex-1 items-end overflow-x-auto pl-1 gap-[1px]">
          {activeEnvTabs.map((tab) => {
            const isSelected = tab.id === activeTabId
            const termIds = collectTerminalIds(tab.root)
            const splitCount = termIds.length
            const tabZoomed = Boolean(zoomedPaneByTab[tab.id] && splitCount > 1)

            // Aggregate worst connection status across panes in this tab
            let statusColor = activeEnv?.color || 'var(--st-green)'
            let pulse = false
            for (const tid of termIds) {
              const st = terminalStatuses[tid]?.state
              if (st === 'disconnected') {
                statusColor = 'var(--st-red)'
                pulse = false
                break
              }
              if (st === 'reconnecting' || st === 'connecting') {
                statusColor = 'var(--st-yellow)'
                pulse = true
              }
            }
            if (tab.hasUnread) {
              statusColor = 'var(--st-dirty)'
              pulse = true
            }

            return (
              <div
                key={tab.id}
                onClick={() => setActiveTerminalTab(activeEnvId, tab.id)}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  setEditingTabId(tab.id)
                  setEditingTitle(tab.title)
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) void closeTerminalTab(activeEnvId, tab.id)
                }}
                className="group relative flex h-[27px] shrink-0 items-center gap-1.5 rounded-t-[4px] px-2.5 text-[11.5px] cursor-pointer select-none border-r transition-colors"
                style={{
                  backgroundColor: isSelected ? 'var(--st-terminal)' : 'var(--st-tab-inactive)',
                  color: isSelected ? 'var(--st-text)' : 'var(--st-text-dim)',
                  borderColor: 'var(--st-border)',
                  borderTop: isSelected
                    ? `2px solid ${activeEnv?.color || 'var(--st-accent)'}`
                    : '2px solid transparent',
                  maxWidth: '215px'
                }}
                title="Double-click to rename tab · Middle-click to close"
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${pulse ? 'st3-attention-pulse' : ''}`}
                  style={{ backgroundColor: statusColor }}
                />

                {editingTabId === tab.id ? (
                  <input
                    autoFocus
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onBlur={() => commitRename(tab.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(tab.id)
                      if (e.key === 'Escape') setEditingTabId(null)
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="w-[105px] rounded px-1 py-0 text-[11px] font-mono outline-none border"
                    style={{
                      backgroundColor: 'var(--st-input)',
                      borderColor: 'var(--st-accent)',
                      color: 'var(--st-text)'
                    }}
                  />
                ) : (
                  <span className="truncate font-mono text-[11.5px]">{tab.title}</span>
                )}

                {splitCount > 1 && (
                  <span
                    className="rounded px-1 text-[9.5px] font-mono shrink-0"
                    style={{
                      backgroundColor: tabZoomed ? 'rgba(249, 174, 88, 0.22)' : 'rgba(255,255,255,0.08)',
                      color: tabZoomed ? 'var(--st-dirty)' : 'var(--st-text-muted)'
                    }}
                    title={tabZoomed ? `${splitCount} panes (1 zoomed · ⌘⇧⏎)` : `${splitCount} split panes`}
                  >
                    {tabZoomed ? `1/${splitCount}` : splitCount}
                  </span>
                )}

                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    void closeTerminalTab(activeEnvId, tab.id)
                  }}
                  title="Close Terminal Tab"
                  className={`ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-white/15 transition-opacity ${
                    isSelected ? 'opacity-50 group-hover:opacity-100' : 'opacity-0 group-hover:opacity-90'
                  }`}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            )
          })}

          {/* Compact iTerm2 New Terminal Tab (+) Button */}
          <button
            onClick={() => void createTerminalTab(activeEnvId)}
            title="New Terminal Tab (⌘T in terminal / ⌘⇧T)"
            className="mb-[3px] ml-1 flex h-[22px] w-[22px] items-center justify-center rounded hover:bg-white/10 transition-colors shrink-0"
            style={{ color: 'var(--st-text-muted)' }}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Right: Reconnect All + Split + iTerm2 Preferences Popover + Maximize */}
        <div className="flex h-full items-center gap-0.5 pl-2">
          {hasDisconnectedInEnv && (
            <button
              onClick={() => void reconnectAllTerminals(true)}
              title="Reconnect all disconnected SSH terminals"
              className="mr-1 flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium hover:brightness-110"
              style={{ backgroundColor: 'rgba(166, 226, 46, 0.16)', color: 'var(--st-accent)' }}
            >
              <RotateCw className="h-3 w-3" />
              <span>Reconnect All</span>
            </button>
          )}
          <button
            onClick={() => void splitTerminal(activeEnvId, 'horizontal')}
            title="Split Vertically / Right (⌘D or ⌘\)"
            className="rounded p-1 hover:bg-white/10 transition-colors"
            style={{ color: 'var(--st-text-dim)' }}
          >
            <Columns2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => void splitTerminal(activeEnvId, 'vertical')}
            title="Split Horizontally / Down (⌘⇧D or ⌘⇧\)"
            className="rounded p-1 hover:bg-white/10 transition-colors"
            style={{ color: 'var(--st-text-dim)' }}
          >
            <Rows2 className="h-3.5 w-3.5" />
          </button>
          <button
            ref={prefsBtnRef}
            onClick={(e) => {
              e.stopPropagation()
              const next = !showPrefs
              if (next) {
                const rect = e.currentTarget.getBoundingClientRect()
                const popH = 310
                const top =
                  rect.bottom + popH < window.innerHeight - 10
                    ? rect.bottom + 5
                    : Math.max(10, rect.top - popH - 5)
                const right = Math.max(8, window.innerWidth - rect.right)
                setPrefsPos({ right, top })
              }
              setShowPrefs(next)
            }}
            title="Terminal Appearance & Behavior (iTerm2 Settings)"
            className="rounded p-1 hover:bg-white/10 transition-colors"
            style={{
              color: showPrefs ? 'var(--st-accent)' : 'var(--st-text-dim)',
              backgroundColor: showPrefs ? 'rgba(255,255,255,0.08)' : undefined
            }}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setLayoutMode(layoutMode === 'terminal' ? 'ide' : 'terminal')}
            title={layoutMode === 'terminal' ? 'Restore IDE Split View' : 'Maximize Terminal Area'}
            className="rounded p-1 hover:bg-white/10 transition-colors"
            style={{ color: 'var(--st-text-dim)' }}
          >
            {layoutMode === 'terminal' ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* iTerm2-Style Live Terminal Preferences Popover */}
      {showPrefs && (
        <div
          ref={prefsRef}
          onMouseDown={(e) => e.stopPropagation()}
          className="fixed z-50 w-[272px] rounded-md border shadow-2xl text-[12px] select-none overflow-hidden"
          style={{
            right: prefsPos.right,
            top: prefsPos.top,
            backgroundColor: 'var(--st-panel)',
            borderColor: 'var(--st-border-light)',
            color: 'var(--st-text)',
            backdropFilter: 'blur(16px)'
          }}
        >
          <div
            className="flex items-center justify-between px-3 py-2 border-b text-[11px] font-semibold tracking-wide uppercase"
            style={{ borderColor: 'var(--st-border)', color: 'var(--st-text-muted)' }}
          >
            <span>Terminal Profile</span>
            <span className="font-mono text-[10px] font-normal opacity-75">Canvas · SF Mono</span>
          </div>

          <div className="p-3 flex flex-col gap-2.5">
            {/* Cursor Shape */}
            <div className="flex items-center justify-between gap-2">
              <span style={{ color: 'var(--st-text-muted)' }}>Cursor</span>
              <div
                className="flex rounded border p-0.5 text-[11px] font-mono"
                style={{ backgroundColor: 'var(--st-input)', borderColor: 'var(--st-border-light)' }}
              >
                {(
                  [
                    ['block', '█ Block'],
                    ['bar', '│ Bar'],
                    ['underline', '▁ Line']
                  ] as const
                ).map(([val, label]) => {
                  const active = terminalPrefs.cursorStyle === val
                  return (
                    <button
                      key={val}
                      onClick={() => updateTerminalPrefs({ cursorStyle: val })}
                      className="rounded px-1.5 py-0.5 transition-colors"
                      style={{
                        backgroundColor: active ? 'rgba(255,255,255,0.14)' : 'transparent',
                        color: active ? 'var(--st-text)' : 'var(--st-text-dim)'
                      }}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Cursor Mode: Steady (iTerm2 default) vs Blink */}
            <div className="flex items-center justify-between gap-2">
              <span style={{ color: 'var(--st-text-muted)' }}>Cursor Blink</span>
              <div
                className="flex rounded border p-0.5 text-[11px]"
                style={{ backgroundColor: 'var(--st-input)', borderColor: 'var(--st-border-light)' }}
              >
                {[
                  [false, 'Steady'],
                  [true, 'Blink']
                ].map(([blink, label]) => {
                  const active = terminalPrefs.cursorBlink === blink
                  return (
                    <button
                      key={String(blink)}
                      onClick={() => updateTerminalPrefs({ cursorBlink: Boolean(blink) })}
                      className="rounded px-2 py-0.5 transition-colors"
                      style={{
                        backgroundColor: active ? 'rgba(255,255,255,0.14)' : 'transparent',
                        color: active ? 'var(--st-text)' : 'var(--st-text-dim)'
                      }}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Font Size Stepper */}
            <div className="flex items-center justify-between gap-2">
              <span style={{ color: 'var(--st-text-muted)' }}>Font Size</span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setFontSizes({ terminalFontSize: terminalFontSize - 1 })}
                  className="flex h-6 w-6 items-center justify-center rounded border hover:bg-white/10"
                  style={{ backgroundColor: 'var(--st-input)', borderColor: 'var(--st-border-light)' }}
                >
                  <Minus className="h-3 w-3" />
                </button>
                <span className="w-10 text-center font-mono text-[11.5px]">{terminalFontSize}px</span>
                <button
                  onClick={() => setFontSizes({ terminalFontSize: terminalFontSize + 1 })}
                  className="flex h-6 w-6 items-center justify-center rounded border hover:bg-white/10"
                  style={{ backgroundColor: 'var(--st-input)', borderColor: 'var(--st-border-light)' }}
                >
                  <Plus className="h-3 w-3" />
                </button>
              </div>
            </div>

            <div className="border-t my-0.5" style={{ borderColor: 'var(--st-border)' }} />

            {/* iTerm2 Signature Toggles */}
            {(
              [
                ['dimInactivePanes', 'Dim inactive split panes'],
                ['copyOnSelect', 'Copy to clipboard on select'],
                ['optionAsMeta', 'Option key as Meta (Esc+)'],
                ['minimumContrast', 'Minimum text contrast']
              ] as const
            ).map(([key, label]) => {
              const checked = terminalPrefs[key]
              return (
                <button
                  key={key}
                  onClick={() => updateTerminalPrefs({ [key]: !checked })}
                  className="flex items-center justify-between rounded px-1.5 py-1 text-left hover:bg-white/5 transition-colors"
                >
                  <span style={{ color: 'var(--st-text)' }}>{label}</span>
                  <span
                    className="flex h-4 w-4 items-center justify-center rounded border transition-colors"
                    style={{
                      backgroundColor: checked ? 'var(--st-accent)' : 'var(--st-input)',
                      borderColor: checked ? 'var(--st-accent)' : 'var(--st-border-light)',
                      color: '#111'
                    }}
                  >
                    {checked && <Check className="h-3 w-3 stroke-[2.75]" />}
                  </span>
                </button>
              )
            })}
          </div>

          <div
            className="px-3 py-1.5 border-t font-mono text-[10px] leading-relaxed"
            style={{
              borderColor: 'var(--st-border)',
              backgroundColor: 'rgba(0,0,0,0.18)',
              color: 'var(--st-text-dim)'
            }}
          >
            ⌘D Split · ⌘[/] Focus · ⌘⇧⏎ Zoom · ⇧⏎ Newline
          </div>
        </div>
      )}

      {/* Mounted Terminal Panes (all envs & all tabs stay mounted with real layout dimensions so
          FitAddon & CanvasRenderer NEVER measure 0px inside `display: none`!) */}
      <div className="relative flex-1 min-h-0 w-full overflow-hidden">
        {Object.entries(terminalTabsByEnv).map(([envId, tabs]) =>
          tabs.map((tab) => {
            const curTabId = activeTerminalTabByEnv[envId] || tabs[0]?.id
            const visible = envId === activeEnvId && tab.id === curTabId
            const leaves = collectLeafNodes(tab.root)
            const paneCount = leaves.length
            const zoomedPaneId = paneCount > 1 ? zoomedPaneByTab[tab.id] : null
            const zoomedLeaf = zoomedPaneId ? leaves.find((l) => l.paneId === zoomedPaneId) : null

            return (
              <div
                key={tab.id}
                aria-hidden={!visible}
                className={
                  visible
                    ? 'absolute inset-0 z-10'
                    : 'absolute inset-0 z-0 invisible pointer-events-none'
                }
              >
                {zoomedLeaf ? (
                  <TerminalInstance
                    envId={envId}
                    tabId={tab.id}
                    paneId={zoomedLeaf.paneId}
                    terminalId={zoomedLeaf.terminalId}
                    title={zoomedLeaf.title}
                    isVisible={visible}
                    paneCount={paneCount}
                    isZoomed={true}
                  />
                ) : (
                  <RecursiveSplit
                    envId={envId}
                    tabId={tab.id}
                    node={tab.root}
                    isVisible={visible}
                    paneCount={paneCount}
                  />
                )}
              </div>
            )
          })
        )}

        {/* Empty state if all tabs in current workspace were closed */}
        {activeEnvTabs.length === 0 && activeEnv && (
          <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-[13px]">
            <Terminal className="h-7 w-7 opacity-40" />
            <div style={{ color: 'var(--st-text-muted)' }}>
              No terminal tabs open in <span className="font-mono font-semibold">{activeEnv.name}</span>
            </div>
            <button
              onClick={() => void createTerminalTab(activeEnv.id)}
              className="flex items-center gap-1.5 rounded px-3.5 py-1.5 text-[12.5px] font-medium text-[#111]"
              style={{ backgroundColor: 'var(--st-accent)' }}
            >
              <Plus className="h-3.5 w-3.5" />
              New Terminal Tab
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
