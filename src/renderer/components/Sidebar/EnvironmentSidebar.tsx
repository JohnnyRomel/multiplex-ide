import React, { useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Layers,
  Plug,
  PlugZap,
  Plus,
  Settings,
  Terminal,
  Trash2
} from 'lucide-react'
import type { Environment } from '@shared/types'
import { collectTerminalIds, useAppStore } from '@renderer/stores/useAppStore'

/**
 * Clean, Sublime Text 3-style WORKSPACES section.
 * Displays ONLY configured workspaces (by default: Local Mac, dev92 ~/workspace, cn_a10 ~)
 * and provides 1-click access to edit config.json right inside the editor!
 */
export const WorkspaceListSection: React.FC = () => {
  const environments = useAppStore((s) => s.environments)
  const activeEnvId = useAppStore((s) => s.activeEnvId)
  const terminalTrees = useAppStore((s) => s.terminalTrees)
  const envNotifications = useAppStore((s) => s.envNotifications)
  const envRootPaths = useAppStore((s) => s.envRootPaths)

  const setActiveEnv = useAppStore((s) => s.setActiveEnv)
  const setEnvironments = useAppStore((s) => s.setEnvironments)
  const upsertEnvironment = useAppStore((s) => s.upsertEnvironment)
  const setShowAddHostModal = useAppStore((s) => s.setShowAddHostModal)
  const openConfigFile = useAppStore((s) => s.openConfigFile)
  const ensureTerminalForEnv = useAppStore((s) => s.ensureTerminalForEnv)
  const addToast = useAppStore((s) => s.addToast)
  const setShowTransferDrawer = useAppStore((s) => s.setShowTransferDrawer)

  const [expanded, setExpanded] = useState(true)
  const [dragOverEnvId, setDragOverEnvId] = useState<string | null>(null)

  const handleSelectEnv = async (env: Environment) => {
    setActiveEnv(env.id)
    if (env.kind === 'ssh' && env.status === 'disconnected') {
      const res = await window.multiplex.connectEnvironment(env.id)
      if (!res.ok && res.needsInteractiveAuth) {
        addToast('info', `${env.name}: complete login in terminal to enable SFTP & Search`)
        await ensureTerminalForEnv(env.id)
      } else if (!res.ok && res.error) {
        addToast('error', `${env.name}: ${res.error}`)
      }
    }
  }

  const handleToggleConnect = async (e: React.MouseEvent, env: Environment) => {
    e.stopPropagation()
    if (env.kind === 'local') return
    if (env.status === 'connected') {
      await window.multiplex.disconnectEnvironment(env.id)
      addToast('info', `Disconnected ${env.name}`)
    } else {
      setActiveEnv(env.id)
      const res = await window.multiplex.connectEnvironment(env.id)
      if (res.ok) {
        addToast('success', `Connected to ${env.name}`)
      } else if (res.needsInteractiveAuth) {
        addToast('info', `Login in ${env.name} terminal to establish SSH ControlMaster`)
        await ensureTerminalForEnv(env.id)
      } else if (res.error) {
        addToast('error', res.error)
      }
    }
  }

  const handleToggleTmux = async (e: React.MouseEvent, env: Environment) => {
    e.stopPropagation()
    const updated = await window.multiplex.updateEnvSettings(env.id, { useTmux: !env.useTmux })
    if (updated) {
      upsertEnvironment(updated)
      addToast('info', `${env.name}: tmux ${updated.useTmux ? 'ON' : 'OFF'}`)
    }
  }

  const handleRemoveEnv = async (e: React.MouseEvent, env: Environment) => {
    e.stopPropagation()
    if (env.kind === 'local') return
    const list = await window.multiplex.deleteCustomHost(env.id)
    setEnvironments(list)
  }

  const handleDropOnEnv = async (e: React.DragEvent, targetEnv: Environment) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOverEnvId(null)

    const targetDir = envRootPaths[targetEnv.id] || targetEnv.defaultPath
    const rawPayload = e.dataTransfer.getData('application/x-multiplex-entry')
    if (rawPayload) {
      try {
        const entry = JSON.parse(rawPayload) as { envId: string; path: string; name: string }
        if (entry.envId === targetEnv.id) return
        setShowTransferDrawer(true)
        await window.multiplex.enqueueTransfer({
          sourceEnvId: entry.envId,
          sourcePath: entry.path,
          targetEnvId: targetEnv.id,
          targetDir
        })
        addToast('info', `Transferring ${entry.name} → ${targetEnv.name}:${targetDir}`)
        return
      } catch {
        // ignore
      }
    }

    const files = Array.from(e.dataTransfer.files || [])
    if (files.length > 0) {
      setShowTransferDrawer(true)
      for (const f of files) {
        const localPath = window.multiplex.getPathForFile(f)
        if (!localPath) continue
        await window.multiplex.enqueueTransfer({
          sourceEnvId: 'local',
          sourcePath: localPath,
          targetEnvId: targetEnv.id,
          targetDir
        })
      }
      addToast('info', `Uploading ${files.length} item(s) → ${targetEnv.name}:${targetDir}`)
    }
  }

  return (
    <div className="border-b pb-1" style={{ borderColor: 'var(--st-border)' }}>
      {/* Sublime Section Header */}
      <div className="flex items-center justify-between px-2.5 py-1.5">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 st3-section-title hover:opacity-90"
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <span>Workspaces</span>
        </button>

        <div className="flex items-center gap-0.5">
          <button
            onClick={() => void openConfigFile()}
            title="Edit Workspace Config JSON (⌘,)"
            className="rounded p-1 hover:bg-white/10"
            style={{ color: 'var(--st-text-dim)' }}
          >
            <Settings className="h-3 w-3" />
          </button>
          <button
            onClick={() => setShowAddHostModal(true)}
            title="Add Workspace"
            className="rounded p-1 hover:bg-white/10"
            style={{ color: 'var(--st-text-dim)' }}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {expanded && (
        <div>
          {environments.map((env, idx) => {
            const isActive = env.id === activeEnvId
            const termCount = collectTerminalIds(terminalTrees[env.id]).length
            const notifs = envNotifications[env.id] || []
            const hasAttention = notifs.length > 0
            const isDragOver = dragOverEnvId === env.id

            const dotColor =
              env.status === 'connected'
                ? 'var(--st-green)'
                : env.status === 'connecting'
                  ? 'var(--st-yellow)'
                  : env.status === 'error'
                    ? 'var(--st-red)'
                    : 'var(--st-text-dim)'

            const subPath = (envRootPaths[env.id] || env.defaultPath).replace(/^\/Users\/[^/]+/, '~')

            return (
              <div
                key={env.id}
                onClick={() => void handleSelectEnv(env)}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragOverEnvId(env.id)
                }}
                onDragLeave={() => setDragOverEnvId((p) => (p === env.id ? null : p))}
                onDrop={(e) => void handleDropOnEnv(e, env)}
                className="group relative flex h-[26px] items-center justify-between gap-1.5 pl-4 pr-2 cursor-pointer text-[12px]"
                style={{
                  backgroundColor: isDragOver
                    ? 'rgba(166, 226, 46, 0.18)'
                    : isActive
                      ? 'var(--st-sidebar-active)'
                      : 'transparent',
                  color: isActive ? 'var(--st-text)' : 'var(--st-text-muted)'
                }}
                onMouseEnter={(e) => {
                  if (!isActive && !isDragOver) e.currentTarget.style.backgroundColor = 'var(--st-sidebar-hover)'
                }}
                onMouseLeave={(e) => {
                  if (!isActive && !isDragOver) e.currentTarget.style.backgroundColor = 'transparent'
                }}
                title={`${env.name} — ${subPath} (⌘${idx + 1})`}
              >
                {/* Thin subtle active bar */}
                {isActive && (
                  <span
                    className="absolute left-0 top-0 bottom-0 w-[2px]"
                    style={{ backgroundColor: env.color }}
                  />
                )}

                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${hasAttention ? 'st3-attention-pulse' : ''}`}
                    style={{ backgroundColor: hasAttention ? 'var(--st-dirty)' : dotColor }}
                  />
                  <span className="truncate font-medium">{env.name}</span>
                  <span
                    className="truncate font-mono text-[10px]"
                    style={{ color: 'var(--st-text-dim)' }}
                  >
                    {subPath}
                  </span>
                </div>

                {/* Right indicators & hover actions */}
                <div className="flex items-center gap-1 shrink-0">
                  {env.kind === 'ssh' && (
                    <div className="hidden group-hover:flex items-center gap-0.5">
                      <button
                        onClick={(e) => void handleToggleConnect(e, env)}
                        title={env.status === 'connected' ? 'Disconnect' : 'Connect'}
                        className="rounded p-0.5 hover:bg-white/10"
                        style={{ color: env.status === 'connected' ? 'var(--st-green)' : 'var(--st-text-muted)' }}
                      >
                        {env.status === 'connected' ? (
                          <PlugZap className="h-3 w-3" />
                        ) : (
                          <Plug className="h-3 w-3" />
                        )}
                      </button>
                      <button
                        onClick={(e) => void handleToggleTmux(e, env)}
                        title={`tmux keep-alive: ${env.useTmux ? 'ON' : 'OFF'}`}
                        className="rounded p-0.5 hover:bg-white/10"
                        style={{ color: env.useTmux ? 'var(--st-accent-blue)' : 'var(--st-text-dim)' }}
                      >
                        <Layers className="h-3 w-3" />
                      </button>
                      <button
                        onClick={(e) => void handleRemoveEnv(e, env)}
                        title="Remove from sidebar (can re-add via config.json)"
                        className="rounded p-0.5 hover:bg-white/10"
                        style={{ color: 'var(--st-text-dim)' }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  )}

                  {termCount > 0 && (
                    <span
                      className="flex items-center gap-0.5 font-mono text-[10px] group-hover:hidden"
                      style={{ color: 'var(--st-text-dim)' }}
                    >
                      <Terminal className="h-2.5 w-2.5" />
                      {termCount}
                    </span>
                  )}

                  {idx < 9 && termCount === 0 && (
                    <span
                      className="font-mono text-[10px] opacity-40 group-hover:hidden"
                      style={{ color: 'var(--st-text-dim)' }}
                    >
                      ⌘{idx + 1}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
