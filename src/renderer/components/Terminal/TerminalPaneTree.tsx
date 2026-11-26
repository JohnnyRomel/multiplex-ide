import React, { useState } from 'react'
import { Allotment } from 'allotment'
import { Columns2, Maximize2, Minimize2, Plus, RotateCw, Rows2, Terminal, X } from 'lucide-react'
import { collectEnvTerminalIds, collectTerminalIds, type TerminalSplitNode, useAppStore } from '@renderer/stores/useAppStore'
import { TerminalInstance } from './TerminalInstance'

const RecursiveSplit: React.FC<{
  envId: string
  tabId: string
  node: TerminalSplitNode
  isVisible: boolean
}> = ({ envId, tabId, node, isVisible }) => {
  if (node.type === 'leaf') {
    return (
      <TerminalInstance
        envId={envId}
        tabId={tabId}
        paneId={node.paneId}
        terminalId={node.terminalId}
        title={node.title}
        isVisible={isVisible}
      />
    )
  }

  return (
    <Allotment vertical={node.direction === 'vertical'} proportionalLayout>
      {node.children.map((child) => (
        <Allotment.Pane key={child.type === 'leaf' ? child.paneId : child.id} minSize={120}>
          <RecursiveSplit envId={envId} tabId={tabId} node={child} isVisible={isVisible} />
        </Allotment.Pane>
      ))}
    </Allotment>
  )
}

export const TerminalWorkspaceArea: React.FC = () => {
  const environments = useAppStore((s) => s.environments)
  const activeEnvId = useAppStore((s) => s.activeEnvId)
  const layoutMode = useAppStore((s) => s.layoutMode)
  const terminalTabsByEnv = useAppStore((s) => s.terminalTabsByEnv)
  const activeTerminalTabByEnv = useAppStore((s) => s.activeTerminalTabByEnv)
  const terminalStatuses = useAppStore((s) => s.terminalStatuses)

  const createTerminalTab = useAppStore((s) => s.createTerminalTab)
  const setActiveTerminalTab = useAppStore((s) => s.setActiveTerminalTab)
  const renameTerminalTab = useAppStore((s) => s.renameTerminalTab)
  const closeTerminalTab = useAppStore((s) => s.closeTerminalTab)
  const splitTerminal = useAppStore((s) => s.splitTerminal)
  const reconnectAllTerminals = useAppStore((s) => s.reconnectAllTerminals)
  const setLayoutMode = useAppStore((s) => s.setLayoutMode)

  const [editingTabId, setEditingTabId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')

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
      {/* cmux / Sublime-style Multi-Tab Terminal Header Bar */}
      <div
        className="flex h-[32px] shrink-0 items-end justify-between border-b pr-2"
        style={{ backgroundColor: 'var(--st-tabbar)', borderColor: 'var(--st-border)' }}
      >
        {/* Left: Scrollable Terminal Tabs + New Tab (`+`) button */}
        <div className="flex h-full flex-1 items-end overflow-x-auto pl-1.5 gap-[1px]">
          {activeEnvTabs.map((tab) => {
            const isSelected = tab.id === activeTabId
            const termIds = collectTerminalIds(tab.root)
            const splitCount = termIds.length

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
                className="group relative flex h-[28px] shrink-0 items-center gap-1.5 rounded-t px-2.5 text-[12px] cursor-pointer select-none border-r"
                style={{
                  backgroundColor: isSelected ? 'var(--st-terminal)' : 'var(--st-tab-inactive)',
                  color: isSelected ? 'var(--st-text)' : 'var(--st-text-dim)',
                  borderColor: 'var(--st-border)',
                  borderTop: isSelected
                    ? `2px solid ${activeEnv?.color || 'var(--st-accent)'}`
                    : '2px solid transparent',
                  maxWidth: '210px'
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
                    className="w-[105px] rounded px-1 py-0 text-[11.5px] font-mono outline-none border"
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
                    style={{ backgroundColor: 'rgba(255,255,255,0.08)', color: 'var(--st-text-muted)' }}
                    title={`${splitCount} split panes`}
                  >
                    {splitCount}
                  </span>
                )}

                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    void closeTerminalTab(activeEnvId, tab.id)
                  }}
                  title="Close Terminal Tab"
                  className="ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-white/10 opacity-45 group-hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )
          })}

          {/* New Terminal Tab (+) Button */}
          <button
            onClick={() => void createTerminalTab(activeEnvId)}
            title="New Terminal Tab (⌘⇧T or ⌘T in terminal)"
            className="mb-1 ml-1 flex h-[24px] items-center gap-1 rounded px-2 text-[11.5px] hover:bg-white/10 transition-colors shrink-0"
            style={{ color: 'var(--st-text-muted)' }}
          >
            <Plus className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">New Tab</span>
          </button>
        </div>

        {/* Right: Reconnect All + Quick Split & Maximize Controls */}
        <div className="flex h-full items-center gap-1 pl-2">
          {hasDisconnectedInEnv && (
            <button
              onClick={() => void reconnectAllTerminals(true)}
              title="Reconnect all disconnected SSH terminals"
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium hover:brightness-110"
              style={{ backgroundColor: 'rgba(166, 226, 46, 0.16)', color: 'var(--st-accent)' }}
            >
              <RotateCw className="h-3 w-3" />
              <span>Reconnect All</span>
            </button>
          )}
          <button
            onClick={() => void splitTerminal(activeEnvId, 'horizontal')}
            title="Split Active Tab Right (⌘\)"
            className="rounded p-1 hover:bg-white/10"
            style={{ color: 'var(--st-text-dim)' }}
          >
            <Columns2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => void splitTerminal(activeEnvId, 'vertical')}
            title="Split Active Tab Down (⌘⇧\)"
            className="rounded p-1 hover:bg-white/10"
            style={{ color: 'var(--st-text-dim)' }}
          >
            <Rows2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setLayoutMode(layoutMode === 'terminal' ? 'ide' : 'terminal')}
            title={layoutMode === 'terminal' ? 'Restore IDE Split View' : 'Maximize Terminal (cmux Mode)'}
            className="rounded p-1 hover:bg-white/10"
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

      {/* Mounted Terminal Panes (all envs & all tabs stay mounted with real layout dimensions so
          xterm DOM WidthCache & FitAddon NEVER measure 0px inside `display: none`!) */}
      <div className="relative flex-1 min-h-0 w-full overflow-hidden">
        {Object.entries(terminalTabsByEnv).map(([envId, tabs]) =>
          tabs.map((tab) => {
            const curTabId = activeTerminalTabByEnv[envId] || tabs[0]?.id
            const visible = envId === activeEnvId && tab.id === curTabId
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
                <RecursiveSplit envId={envId} tabId={tab.id} node={tab.root} isVisible={visible} />
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
