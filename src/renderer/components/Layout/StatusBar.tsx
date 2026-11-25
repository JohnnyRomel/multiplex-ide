import React from 'react'
import { GitBranch, UploadCloud } from 'lucide-react'
import type { EditorThemeId } from '@shared/types'
import { useAppStore } from '@renderer/stores/useAppStore'

const THEME_CYCLE: EditorThemeId[] = ['monokai', 'mariana', 'boxy']
const THEME_LABELS: Record<EditorThemeId, string> = {
  monokai: 'Monokai',
  mariana: 'Mariana',
  boxy: 'Boxy Dark'
}

export const StatusBar: React.FC = () => {
  const activeEnvId = useAppStore((s) => s.activeEnvId)
  const environments = useAppStore((s) => s.environments)
  const envGitBranches = useAppStore((s) => s.envGitBranches)
  const cursorInfo = useAppStore((s) => s.cursorInfo)
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  const editorFontSize = useAppStore((s) => s.editorFontSize)
  const terminalFontSize = useAppStore((s) => s.terminalFontSize)
  const adjustFontSize = useAppStore((s) => s.adjustFontSize)
  const resetFontSizes = useAppStore((s) => s.resetFontSizes)
  const transfers = useAppStore((s) => s.transfers)
  const showTransferDrawer = useAppStore((s) => s.showTransferDrawer)
  const setShowTransferDrawer = useAppStore((s) => s.setShowTransferDrawer)

  const env = environments.find((e) => e.id === activeEnvId)
  const branch = envGitBranches[activeEnvId]
  const runningTransfers = transfers.filter((t) => t.status === 'running' || t.status === 'queued')

  const nextTheme = () => {
    const idx = THEME_CYCLE.indexOf(theme)
    setTheme(THEME_CYCLE[(idx + 1) % THEME_CYCLE.length])
  }

  return (
    <footer
      className="flex h-[26px] shrink-0 items-center justify-between border-t px-3 text-[12px] select-none"
      style={{
        backgroundColor: 'var(--st-statusbar)',
        borderColor: 'var(--st-border)',
        color: 'var(--st-text-dim)'
      }}
    >
      <div className="flex items-center gap-3 min-w-0">
        {env && (
          <button
            onClick={async () => {
              if (env.kind === 'ssh' && env.status !== 'connected') {
                await window.multiplex.connectEnvironment(env.id)
                await window.multiplex.reconnectAllTerminals()
              }
            }}
            title={
              env.kind === 'ssh' && env.status !== 'connected'
                ? `Click to reconnect ${env.name}`
                : `Active workspace: ${env.name}`
            }
            className={`flex items-center gap-1.5 font-mono ${env.kind === 'ssh' && env.status !== 'connected' ? 'hover:underline cursor-pointer' : 'cursor-default'}`}
          >
            <span
              className={`h-2 w-2 rounded-full ${env.status === 'connecting' ? 'st3-attention-pulse' : ''}`}
              style={{
                backgroundColor:
                  env.status === 'connected'
                    ? 'var(--st-green)'
                    : env.status === 'connecting'
                      ? 'var(--st-yellow)'
                      : env.status === 'error'
                        ? 'var(--st-red)'
                        : 'var(--st-text-dim)'
              }}
            />
            <span style={{ color: 'var(--st-text-muted)' }}>{env.name}</span>
            <span className="opacity-75">({env.kind === 'local' ? 'local' : env.status})</span>
          </button>
        )}

        {branch && (
          <span className="flex items-center gap-1 font-mono" style={{ color: 'var(--st-text-muted)' }}>
            <GitBranch className="h-3.5 w-3.5" />
            {branch}
          </span>
        )}

        {runningTransfers.length > 0 && (
          <button
            onClick={() => setShowTransferDrawer(!showTransferDrawer)}
            className="flex items-center gap-1 hover:opacity-90"
            style={{ color: 'var(--st-accent)' }}
          >
            <UploadCloud className="h-3.5 w-3.5 animate-pulse" />
            <span>Transferring {runningTransfers.length}...</span>
          </button>
        )}
      </div>

      <div className="flex items-center gap-4 font-mono text-[11.5px]">
        <span>
          Line {cursorInfo.line}, Column {cursorInfo.column}
        </span>
        <span>Spaces: {cursorInfo.tabSize}</span>
        <span>UTF-8</span>
        <span className="capitalize" style={{ color: 'var(--st-text-muted)' }}>
          {cursorInfo.language}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => adjustFontSize(-1)}
            title="Decrease Font Size (⌘-)"
            className="rounded px-1 hover:bg-white/10"
            style={{ color: 'var(--st-text-muted)' }}
          >
            A-
          </button>
          <button
            onClick={resetFontSizes}
            title={`Reset Font Size (⌘0) · Editor ${editorFontSize}px / Terminal ${terminalFontSize}px`}
            className="rounded px-1 hover:bg-white/10"
            style={{ color: 'var(--st-text-muted)' }}
          >
            {editorFontSize}/{terminalFontSize}px
          </button>
          <button
            onClick={() => adjustFontSize(1)}
            title="Increase Font Size (⌘+)"
            className="rounded px-1 hover:bg-white/10"
            style={{ color: 'var(--st-text-muted)' }}
          >
            A+
          </button>
        </div>
        <button
          onClick={nextTheme}
          title="Switch Sublime Theme (Monokai / Mariana / Boxy Dark)"
          className="hover:underline"
          style={{ color: 'var(--st-text-muted)' }}
        >
          Theme: {THEME_LABELS[theme]}
        </button>
      </div>
    </footer>
  )
}
