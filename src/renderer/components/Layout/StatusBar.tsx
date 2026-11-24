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
      className="flex h-[22px] shrink-0 items-center justify-between border-t px-3 text-[11px] select-none"
      style={{
        backgroundColor: 'var(--st-statusbar)',
        borderColor: 'var(--st-border)',
        color: 'var(--st-text-dim)'
      }}
    >
      <div className="flex items-center gap-3 min-w-0">
        {env && (
          <span className="font-mono">
            {env.name} ({env.kind === 'local' ? 'local' : env.status})
          </span>
        )}

        {branch && (
          <span className="flex items-center gap-1 font-mono" style={{ color: 'var(--st-text-muted)' }}>
            <GitBranch className="h-3 w-3" />
            {branch}
          </span>
        )}

        {runningTransfers.length > 0 && (
          <button
            onClick={() => setShowTransferDrawer(!showTransferDrawer)}
            className="flex items-center gap-1 hover:opacity-90"
            style={{ color: 'var(--st-accent)' }}
          >
            <UploadCloud className="h-3 w-3 animate-pulse" />
            <span>Transferring {runningTransfers.length}...</span>
          </button>
        )}
      </div>

      <div className="flex items-center gap-4 font-mono text-[10.5px]">
        <span>
          Line {cursorInfo.line}, Column {cursorInfo.column}
        </span>
        <span>Spaces: {cursorInfo.tabSize}</span>
        <span>UTF-8</span>
        <span className="capitalize" style={{ color: 'var(--st-text-muted)' }}>
          {cursorInfo.language}
        </span>
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
