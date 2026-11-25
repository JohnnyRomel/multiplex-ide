import React from 'react'
import { ArrowDown, ArrowLeftRight, ArrowUp, CheckCircle2, Trash2, X, XCircle } from 'lucide-react'
import { useAppStore } from '@renderer/stores/useAppStore'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export const TransferQueueDrawer: React.FC = () => {
  const show = useAppStore((s) => s.showTransferDrawer)
  const setShow = useAppStore((s) => s.setShowTransferDrawer)
  const transfers = useAppStore((s) => s.transfers)
  const setTransfers = useAppStore((s) => s.setTransfers)
  const environments = useAppStore((s) => s.environments)

  if (!show) return null

  const envName = (id: string) => environments.find((e) => e.id === id)?.name || id

  const handleClear = async () => {
    const remaining = await window.multiplex.clearFinishedTransfers()
    setTransfers(remaining)
  }

  return (
    <div
      className="fixed right-3 bottom-9 z-40 w-[420px] max-h-[400px] flex flex-col rounded-lg border shadow-2xl overflow-hidden"
      style={{ backgroundColor: 'var(--st-panel)', borderColor: 'var(--st-border-light)' }}
    >
      <div
        className="flex items-center justify-between px-3.5 py-2 border-b"
        style={{ backgroundColor: 'var(--st-titlebar)', borderColor: 'var(--st-border)' }}
      >
        <span className="text-[12.5px] font-semibold">File Transfers ({transfers.length})</span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleClear}
            title="Clear completed"
            className="rounded p-1 hover:bg-white/10"
            style={{ color: 'var(--st-text-muted)' }}
          >
            <Trash2 className="h-4 w-4" />
          </button>
          <button
            onClick={() => setShow(false)}
            className="rounded p-1 hover:bg-white/10"
            style={{ color: 'var(--st-text-muted)' }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto divide-y" style={{ borderColor: 'var(--st-border)' }}>
        {transfers.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12.5px]" style={{ color: 'var(--st-text-dim)' }}>
            No transfers yet. Drag files between Local & SSH trees or drop from Finder.
          </div>
        ) : (
          transfers.map((t) => {
            const pct = t.totalBytes > 0 ? Math.min(100, Math.round((t.bytesTransferred / t.totalBytes) * 100)) : t.status === 'completed' ? 100 : 0
            return (
              <div key={t.id} className="px-3.5 py-2.5 text-[12px] space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {t.direction === 'upload' ? (
                      <ArrowUp className="h-4 w-4 shrink-0" style={{ color: 'var(--st-accent)' }} />
                    ) : t.direction === 'download' ? (
                      <ArrowDown className="h-4 w-4 shrink-0" style={{ color: 'var(--st-green)' }} />
                    ) : (
                      <ArrowLeftRight className="h-4 w-4 shrink-0" style={{ color: 'var(--st-purple)' }} />
                    )}
                    <span className="truncate font-medium" style={{ color: 'var(--st-text)' }}>
                      {t.itemName}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {t.status === 'completed' && (
                      <CheckCircle2 className="h-4 w-4" style={{ color: 'var(--st-green)' }} />
                    )}
                    {t.status === 'failed' && <XCircle className="h-4 w-4" style={{ color: 'var(--st-red)' }} />}
                    {(t.status === 'running' || t.status === 'queued') && (
                      <button
                        onClick={() => void window.multiplex.cancelTransfer(t.id)}
                        className="rounded px-1.5 py-0.5 text-[11px] hover:bg-white/10"
                        style={{ color: 'var(--st-red)' }}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>

                <div className="truncate font-mono text-[11px]" style={{ color: 'var(--st-text-dim)' }}>
                  {envName(t.sourceEnvId)} → {envName(t.targetEnvId)}:{t.targetDir}
                </div>

                {(t.status === 'running' || t.status === 'queued') && (
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/30">
                    <div
                      className="h-full transition-all duration-150"
                      style={{ width: `${pct}%`, backgroundColor: 'var(--st-accent-strong)' }}
                    />
                  </div>
                )}

                <div className="flex items-center justify-between text-[11px] font-mono" style={{ color: 'var(--st-text-muted)' }}>
                  <span>
                    {formatBytes(t.bytesTransferred)}
                    {t.totalBytes > 0 ? ` / ${formatBytes(t.totalBytes)}` : ''}
                    {t.totalFiles > 1 ? ` (${t.filesCompleted}/${t.totalFiles} files)` : ''}
                  </span>
                  <span>
                    {t.status === 'running' && t.speedBps > 0
                      ? `${formatBytes(t.speedBps)}/s`
                      : t.status.toUpperCase()}
                  </span>
                </div>

                {t.error && (
                  <div className="text-[11px] break-all" style={{ color: 'var(--st-red)' }}>
                    {t.error}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
