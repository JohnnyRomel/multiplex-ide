import React from 'react'
import {
  ArrowLeftRight,
  Columns2,
  PanelBottom,
  PanelLeft,
  Search,
  Settings,
  Square,
  Terminal,
  UploadCloud
} from 'lucide-react'
import type { LayoutMode } from '@shared/types'
import { useAppStore } from '@renderer/stores/useAppStore'

export const TopToolbar: React.FC = () => {
  const layoutMode = useAppStore((s) => s.layoutMode)
  const setLayoutMode = useAppStore((s) => s.setLayoutMode)
  const showSidebar = useAppStore((s) => s.showSidebar)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const showTerminalPanel = useAppStore((s) => s.showTerminalPanel)
  const toggleTerminalPanel = useAppStore((s) => s.toggleTerminalPanel)
  const showSearchPanel = useAppStore((s) => s.showSearchPanel)
  const setShowSearchPanel = useAppStore((s) => s.setShowSearchPanel)
  const setShowQuickOpen = useAppStore((s) => s.setShowQuickOpen)
  const showTransferDrawer = useAppStore((s) => s.showTransferDrawer)
  const setShowTransferDrawer = useAppStore((s) => s.setShowTransferDrawer)
  const editorColumns = useAppStore((s) => s.editorColumns)
  const setEditorColumns = useAppStore((s) => s.setEditorColumns)
  const openConfigFile = useAppStore((s) => s.openConfigFile)
  const activeEnvId = useAppStore((s) => s.activeEnvId)
  const environments = useAppStore((s) => s.environments)
  const transfers = useAppStore((s) => s.transfers)
  const setActiveEnv = useAppStore((s) => s.setActiveEnv)

  const activeTransfers = transfers.filter((t) => t.status === 'running' || t.status === 'queued').length

  const modeBtn = (mode: LayoutMode, label: string, Icon: React.FC<{ className?: string }>) => {
    const active = layoutMode === mode
    return (
      <button
        onClick={() => setLayoutMode(mode)}
        className="flex items-center gap-1 rounded-sm px-2 py-0.5 text-[11px] transition-colors"
        style={{
          backgroundColor: active ? 'var(--st-sidebar-active)' : 'transparent',
          color: active ? 'var(--st-text)' : 'var(--st-text-dim)'
        }}
      >
        <Icon className="h-3 w-3" />
        <span>{label}</span>
      </button>
    )
  }

  return (
    <header
      className="drag-region flex h-[34px] shrink-0 items-center justify-between border-b pl-[78px] pr-2.5"
      style={{ backgroundColor: 'var(--st-titlebar)', borderColor: 'var(--st-border)' }}
    >
      {/* Left: Quick Workspace Tabs (always visible for instant switching between Local, dev92, cn_a10!) */}
      <div className="no-drag flex items-center gap-1">
        {environments.map((env) => {
          const isActive = env.id === activeEnvId
          return (
            <button
              key={env.id}
              onClick={() => setActiveEnv(env.id)}
              className="flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-[11px] transition-colors"
              style={{
                backgroundColor: isActive ? 'var(--st-sidebar-active)' : 'transparent',
                color: isActive ? 'var(--st-text)' : 'var(--st-text-dim)'
              }}
              title={`Switch to ${env.name}`}
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{
                  backgroundColor:
                    env.status === 'connected' ? 'var(--st-green)' : 'var(--st-text-dim)'
                }}
              />
              <span className="font-mono">{env.name}</span>
            </button>
          )
        })}
      </div>

      {/* Center: Mode Switcher + Goto Files */}
      <div className="no-drag flex items-center gap-2">
        <div
          className="flex items-center rounded-sm p-0.5 border"
          style={{ backgroundColor: 'var(--st-input)', borderColor: 'var(--st-border)' }}
        >
          {modeBtn('ide', 'Editor', PanelLeft)}
          {modeBtn('terminal', 'Terminal', Terminal)}
          {modeBtn('transfer', 'Transfer', ArrowLeftRight)}
        </div>

        <button
          onClick={() => setShowQuickOpen(true)}
          className="flex items-center gap-2 rounded-sm border px-2.5 py-0.5 text-[11px] hover:bg-white/5"
          style={{
            backgroundColor: 'var(--st-input)',
            borderColor: 'var(--st-border-light)',
            color: 'var(--st-text-dim)'
          }}
          title="Goto Anything (⌘P)"
        >
          <span>Goto Files...</span>
          <kbd className="font-mono text-[10px]">⌘P</kbd>
        </button>
      </div>

      {/* Right: Subtle Sublime utility icons */}
      <div className="no-drag flex items-center gap-0.5">
        <button
          onClick={() => setShowSearchPanel(!showSearchPanel)}
          title="Find in Files (⌘⇧F)"
          className="rounded p-1.5 hover:bg-white/10"
          style={{ color: showSearchPanel ? 'var(--st-text)' : 'var(--st-text-dim)' }}
        >
          <Search className="h-3.5 w-3.5" />
        </button>

        <button
          onClick={() => setEditorColumns(editorColumns === 1 ? 2 : 1)}
          title={editorColumns === 1 ? '2-Column Editor (⌥⌘2)' : 'Single Column (⌥⌘1)'}
          className="rounded p-1.5 hover:bg-white/10"
          style={{ color: editorColumns === 2 ? 'var(--st-text)' : 'var(--st-text-dim)' }}
        >
          {editorColumns === 2 ? <Columns2 className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
        </button>

        <button
          onClick={toggleSidebar}
          title="Toggle Sidebar (⌘B)"
          className="rounded p-1.5 hover:bg-white/10"
          style={{ color: showSidebar ? 'var(--st-text)' : 'var(--st-text-dim)' }}
        >
          <PanelLeft className="h-3.5 w-3.5" />
        </button>

        <button
          onClick={toggleTerminalPanel}
          title="Toggle Terminal Panel (⌘J)"
          className="rounded p-1.5 hover:bg-white/10"
          style={{ color: showTerminalPanel ? 'var(--st-text)' : 'var(--st-text-dim)' }}
        >
          <PanelBottom className="h-3.5 w-3.5" />
        </button>

        <button
          onClick={() => setShowTransferDrawer(!showTransferDrawer)}
          title="Transfers"
          className="relative flex items-center gap-1 rounded p-1.5 hover:bg-white/10"
          style={{ color: activeTransfers > 0 ? 'var(--st-accent)' : 'var(--st-text-dim)' }}
        >
          <UploadCloud className="h-3.5 w-3.5" />
          {activeTransfers > 0 && (
            <span className="font-mono text-[10px] font-bold">{activeTransfers}</span>
          )}
        </button>

        <button
          onClick={() => void openConfigFile()}
          title="Open config.json (⌘,)"
          className="rounded p-1.5 hover:bg-white/10"
          style={{ color: 'var(--st-text-dim)' }}
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
      </div>
    </header>
  )
}
