import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeftRight,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  File,
  FileCode,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  Terminal,
  Upload,
  X
} from 'lucide-react'
import type { Environment, FileEntry } from '@shared/types'
import { useAppStore } from '@renderer/stores/useAppStore'
import { WorkspaceListSection } from '../Sidebar/EnvironmentSidebar'

interface TreeNodeProps {
  env: Environment
  entry: FileEntry
  depth: number
  expanded: Set<string>
  childrenMap: Record<string, FileEntry[]>
  loadingDirs: Set<string>
  gitStatusMap: Record<string, string>
  showHidden: boolean
  dragOverPath: string | null
  onToggleDir: (dirPath: string) => void
  onOpenFile: (filePath: string) => void
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void
  onDragStartEntry: (e: React.DragEvent, entry: FileEntry) => void
  onDragOverDir: (e: React.DragEvent, targetDir: string) => void
  onDragLeaveDir: (targetDir: string) => void
  onDropOnDir: (e: React.DragEvent, targetDir: string) => void
}

function getFileIconColor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['ts', 'tsx'].includes(ext)) return '#66d9ef'
  if (['js', 'jsx', 'mjs'].includes(ext)) return '#e6db74'
  if (['py'].includes(ext)) return '#a6e22e'
  if (['go'].includes(ext)) return '#5fb3b3'
  if (['rs', 'c', 'cpp', 'h'].includes(ext)) return '#fd971f'
  if (['json', 'yaml', 'yml', 'toml'].includes(ext)) return '#ae81ff'
  return 'var(--st-text-dim)'
}

const TreeNodeRow: React.FC<TreeNodeProps> = ({
  env,
  entry,
  depth,
  expanded,
  childrenMap,
  loadingDirs,
  gitStatusMap,
  showHidden,
  dragOverPath,
  onToggleDir,
  onOpenFile,
  onContextMenu,
  onDragStartEntry,
  onDragOverDir,
  onDragLeaveDir,
  onDropOnDir
}) => {
  const isOpen = entry.isDirectory && expanded.has(entry.path)
  const isLoading = loadingDirs.has(entry.path)
  const dropTargetDir = entry.isDirectory ? entry.path : entry.path.slice(0, entry.path.lastIndexOf('/')) || '/'
  const isDropHighlight = entry.isDirectory && dragOverPath === entry.path
  const gitFlag = gitStatusMap[entry.path]
  const children = (childrenMap[entry.path] || []).filter((c) => showHidden || !c.name.startsWith('.'))

  return (
    <>
      <div
        draggable
        onDragStart={(e) => onDragStartEntry(e, entry)}
        onDragOver={(e) => onDragOverDir(e, dropTargetDir)}
        onDragLeave={() => onDragLeaveDir(dropTargetDir)}
        onDrop={(e) => onDropOnDir(e, dropTargetDir)}
        onContextMenu={(e) => onContextMenu(e, entry)}
        onClick={() => {
          if (entry.isDirectory) onToggleDir(entry.path)
          else onOpenFile(entry.path)
        }}
        className="group flex h-[25px] items-center gap-1.5 pr-2 cursor-pointer text-[13px]"
        style={{
          paddingLeft: `${10 + depth * 14}px`,
          backgroundColor: isDropHighlight ? 'rgba(166, 226, 46, 0.2)' : 'transparent'
        }}
        onMouseEnter={(e) => {
          if (!isDropHighlight) e.currentTarget.style.backgroundColor = 'var(--st-sidebar-hover)'
        }}
        onMouseLeave={(e) => {
          if (!isDropHighlight) e.currentTarget.style.backgroundColor = 'transparent'
        }}
        title={`${entry.path}${env.kind === 'ssh' ? ' (Drag between trees to transfer, or ⌥+Drag to Finder)' : ''}`}
      >
        <span className="flex w-4 shrink-0 items-center justify-center" style={{ color: 'var(--st-text-dim)' }}>
          {entry.isDirectory ? (
            isOpen ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )
          ) : null}
        </span>

        {entry.isDirectory ? (
          isOpen ? (
            <FolderOpen className="h-4 w-4 shrink-0" style={{ color: 'var(--st-text-muted)' }} />
          ) : (
            <Folder className="h-4 w-4 shrink-0" style={{ color: 'var(--st-text-dim)' }} />
          )
        ) : (
          <FileCode className="h-4 w-4 shrink-0" style={{ color: getFileIconColor(entry.name) }} />
        )}

        <span
          className="truncate flex-1"
          style={{
            color:
              gitFlag === 'M'
                ? 'var(--st-yellow)'
                : gitFlag === '??' || gitFlag === 'A'
                  ? 'var(--st-green)'
                  : entry.name.startsWith('.')
                    ? 'var(--st-text-dim)'
                    : 'var(--st-text)'
          }}
        >
          {entry.name}
        </span>

        {isLoading && (
          <RefreshCw className="h-3 w-3 animate-spin shrink-0" style={{ color: 'var(--st-text-dim)' }} />
        )}

        {gitFlag && !isLoading && (
          <span
            className="text-[10.5px] font-mono shrink-0"
            style={{ color: gitFlag === 'M' ? 'var(--st-yellow)' : 'var(--st-green)' }}
          >
            {gitFlag}
          </span>
        )}
      </div>

      {isOpen &&
        children.map((child) => (
          <TreeNodeRow
            key={child.path}
            env={env}
            entry={child}
            depth={depth + 1}
            expanded={expanded}
            childrenMap={childrenMap}
            loadingDirs={loadingDirs}
            gitStatusMap={gitStatusMap}
            showHidden={showHidden}
            dragOverPath={dragOverPath}
            onToggleDir={onToggleDir}
            onOpenFile={onOpenFile}
            onContextMenu={onContextMenu}
            onDragStartEntry={onDragStartEntry}
            onDragOverDir={onDragOverDir}
            onDragLeaveDir={onDragLeaveDir}
            onDropOnDir={onDropOnDir}
          />
        ))}
    </>
  )
}

interface SingleEnvTreeProps {
  envId: string
  headerSlot?: React.ReactNode
  extraRightActions?: React.ReactNode
  showOpenFilesSection?: boolean
}

export const SingleEnvFileTree: React.FC<SingleEnvTreeProps> = ({
  envId,
  headerSlot,
  extraRightActions,
  showOpenFilesSection = false
}) => {
  const environments = useAppStore((s) => s.environments)
  const envRootPaths = useAppStore((s) => s.envRootPaths)
  const setEnvRootPath = useAppStore((s) => s.setEnvRootPath)
  const envGitStatus = useAppStore((s) => s.envGitStatus)
  const dirRefreshNonce = useAppStore((s) => s.dirRefreshNonce[envId] || 0)
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const closeTab = useAppStore((s) => s.closeTab)
  const openFile = useAppStore((s) => s.openFile)
  const createTerminalTab = useAppStore((s) => s.createTerminalTab)
  const splitTerminal = useAppStore((s) => s.splitTerminal)
  const ensureTerminalForEnv = useAppStore((s) => s.ensureTerminalForEnv)
  const setShowTransferDrawer = useAppStore((s) => s.setShowTransferDrawer)
  const addToast = useAppStore((s) => s.addToast)
  const bumpDirRefresh = useAppStore((s) => s.bumpDirRefresh)

  const env = environments.find((e) => e.id === envId)
  const rootPath = envRootPaths[envId] || env?.defaultPath || '~'

  const [pathInput, setPathInput] = useState(rootPath)
  const [resolvedRoot, setResolvedRoot] = useState(rootPath)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [childrenMap, setChildrenMap] = useState<Record<string, FileEntry[]>>({})
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set())
  const [rootError, setRootError] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [dragOverPath, setDragOverPath] = useState<string | null>(null)
  const [openFilesExpanded, setOpenFilesExpanded] = useState(true)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null)
  const [inlinePrompt, setInlinePrompt] = useState<{
    mode: 'new-file' | 'new-folder' | 'rename'
    parentDir: string
    targetEntry?: FileEntry
    value: string
  } | null>(null)

  const expandedRef = useRef(expanded)
  expandedRef.current = expanded

  useEffect(() => {
    setPathInput(rootPath)
  }, [rootPath])

  const loadDirectory = useCallback(
    async (dirPath: string, isRoot = false) => {
      if (!env) return
      setLoadingDirs((prev) => new Set(prev).add(dirPath))
      if (isRoot) setRootError(null)
      try {
        const res = await window.multiplex.readDir(env.id, dirPath)
        setChildrenMap((prev) => ({ ...prev, [res.path]: res.entries }))
        if (isRoot) {
          setResolvedRoot(res.path)
          setPathInput(res.path)
          if (res.path !== rootPath) {
            setEnvRootPath(env.id, res.path)
          }
        }
      } catch (err: any) {
        if (isRoot) {
          setRootError(err?.message || String(err))
        } else {
          addToast('error', `Read dir failed: ${err?.message || err}`)
        }
      } finally {
        setLoadingDirs((prev) => {
          const next = new Set(prev)
          next.delete(dirPath)
          return next
        })
      }
    },
    [env, rootPath, setEnvRootPath, addToast]
  )

  useEffect(() => {
    if (!env) return
    if (env.kind === 'ssh' && env.status !== 'connected') {
      setChildrenMap({})
      setRootError(null)
      return
    }
    void loadDirectory(rootPath, true)
  }, [env?.id, env?.status, rootPath, dirRefreshNonce])

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [contextMenu])

  if (!env) return null

  const rootEntries = (childrenMap[resolvedRoot] || []).filter((e) => showHidden || !e.name.startsWith('.'))

  const handleToggleDir = (dirPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(dirPath)) {
        next.delete(dirPath)
      } else {
        next.add(dirPath)
        if (!childrenMap[dirPath]) {
          void loadDirectory(dirPath, false)
        }
      }
      return next
    })
  }

  const handleNavigateUp = () => {
    if (!resolvedRoot || resolvedRoot === '/') return
    const parent = resolvedRoot.slice(0, resolvedRoot.lastIndexOf('/')) || '/'
    setEnvRootPath(env.id, parent)
    setExpanded(new Set())
  }

  const handlePickLocalFolder = async () => {
    if (env.kind !== 'local') return
    const picked = await window.multiplex.pickLocalDir()
    if (picked) {
      setEnvRootPath(env.id, picked)
      setExpanded(new Set())
    }
  }

  const handleUploadViaPicker = async () => {
    const localPaths = await window.multiplex.pickLocalFiles()
    if (localPaths.length === 0) return
    setShowTransferDrawer(true)
    for (const lp of localPaths) {
      await window.multiplex.enqueueTransfer({
        sourceEnvId: 'local',
        sourcePath: lp,
        targetEnvId: env.id,
        targetDir: resolvedRoot
      })
    }
    addToast('info', `Queued ${localPaths.length} item(s) → ${env.name}:${resolvedRoot}`)
  }

  const handleDragStartEntry = (e: React.DragEvent, entry: FileEntry) => {
    e.stopPropagation()

    if (e.altKey) {
      e.preventDefault()
      addToast('info', `Staging ${entry.name} for Finder drag...`)
      void window.multiplex
        .startNativeDrag(env.id, entry.path)
        .catch((err: any) => addToast('error', err?.message || String(err)))
      return
    }

    e.dataTransfer.effectAllowed = 'copyMove'
    e.dataTransfer.setData(
      'application/x-multiplex-entry',
      JSON.stringify({
        envId: env.id,
        path: entry.path,
        name: entry.name,
        isDirectory: entry.isDirectory
      })
    )
    e.dataTransfer.setData('text/plain', entry.path)
  }

  const handleDropOnDir = async (e: React.DragEvent, targetDir: string) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOverPath(null)

    const raw = e.dataTransfer.getData('application/x-multiplex-entry')
    if (raw) {
      try {
        const src = JSON.parse(raw) as { envId: string; path: string; name: string; isDirectory: boolean }
        if (src.envId === env.id) {
          const destPath = `${targetDir.replace(/\/$/, '')}/${src.name}`
          if (destPath === src.path || targetDir.startsWith(src.path + '/')) return
          await window.multiplex.renameEntry(env.id, src.path, destPath)
          addToast('success', `Moved ${src.name} → ${targetDir}`)
          bumpDirRefresh(env.id)
          void loadDirectory(resolvedRoot, true)
          return
        }
        setShowTransferDrawer(true)
        await window.multiplex.enqueueTransfer({
          sourceEnvId: src.envId,
          sourcePath: src.path,
          targetEnvId: env.id,
          targetDir
        })
        addToast('info', `Transferring ${src.name} → ${env.name}:${targetDir}`)
        return
      } catch (err: any) {
        addToast('error', `Drop failed: ${err?.message || err}`)
        return
      }
    }

    const droppedFiles = Array.from(e.dataTransfer.files || [])
    if (droppedFiles.length > 0) {
      setShowTransferDrawer(true)
      let queued = 0
      for (const file of droppedFiles) {
        const localPath = window.multiplex.getPathForFile(file)
        if (!localPath) continue
        await window.multiplex.enqueueTransfer({
          sourceEnvId: 'local',
          sourcePath: localPath,
          targetEnvId: env.id,
          targetDir
        })
        queued++
      }
      if (queued > 0) {
        addToast('info', `Uploading ${queued} item(s) → ${env.name}:${targetDir}`)
      }
    }
  }

  const handleInlineSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!inlinePrompt || !inlinePrompt.value.trim()) {
      setInlinePrompt(null)
      return
    }
    const name = inlinePrompt.value.trim()
    try {
      if (inlinePrompt.mode === 'new-file') {
        const full = `${inlinePrompt.parentDir.replace(/\/$/, '')}/${name}`
        await window.multiplex.createFile(env.id, full)
        void openFile(env.id, full)
      } else if (inlinePrompt.mode === 'new-folder') {
        const full = `${inlinePrompt.parentDir.replace(/\/$/, '')}/${name}`
        await window.multiplex.mkdir(env.id, full)
      } else if (inlinePrompt.mode === 'rename' && inlinePrompt.targetEntry) {
        const parent =
          inlinePrompt.targetEntry.path.slice(0, inlinePrompt.targetEntry.path.lastIndexOf('/')) || '/'
        const nextPath = `${parent.replace(/\/$/, '')}/${name}`
        await window.multiplex.renameEntry(env.id, inlinePrompt.targetEntry.path, nextPath)
      }
      void loadDirectory(resolvedRoot, true)
      if (expandedRef.current.has(inlinePrompt.parentDir)) {
        void loadDirectory(inlinePrompt.parentDir, false)
      }
    } catch (err: any) {
      addToast('error', err?.message || String(err))
    } finally {
      setInlinePrompt(null)
    }
  }

  const handleDeleteEntry = async (entry: FileEntry) => {
    const confirmed = window.confirm(`Delete "${entry.name}" on ${env.name}?`)
    if (!confirmed) return
    try {
      await window.multiplex.deleteEntry(env.id, entry.path)
      addToast('info', `Deleted ${entry.name}`)
      void loadDirectory(resolvedRoot, true)
    } catch (err: any) {
      addToast('error', `Delete failed: ${err?.message || err}`)
    }
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden"
      style={{ backgroundColor: 'var(--st-sidebar)' }}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOverPath(resolvedRoot)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOverPath(null)
      }}
      onDrop={(e) => void handleDropOnDir(e, resolvedRoot)}
    >
      {/* Classic Sublime Text 3 "OPEN FILES" Section */}
      {showOpenFilesSection && tabs.length > 0 && (
        <div className="border-b pb-1" style={{ borderColor: 'var(--st-border)' }}>
          <button
            onClick={() => setOpenFilesExpanded((v) => !v)}
            className="flex w-full items-center gap-1 px-2.5 py-1.5 st3-section-title hover:opacity-90"
          >
            {openFilesExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <span>Open Files</span>
          </button>

          {openFilesExpanded && (
            <div className="max-h-[160px] overflow-y-auto">
              {tabs.map((tab) => {
                const tabEnv = environments.find((e) => e.id === tab.envId)
                const isActive = tab.id === activeTabId
                return (
                  <div
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className="group flex h-[25px] items-center gap-1.5 pl-4 pr-2 text-[13px] cursor-pointer"
                    style={{
                      backgroundColor: isActive ? 'var(--st-sidebar-active)' : 'transparent',
                      color: isActive ? 'var(--st-text)' : 'var(--st-text-muted)'
                    }}
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        closeTab(tab.id)
                      }}
                      className="flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-white/15"
                      title="Close"
                    >
                      {tab.isDirty ? (
                        <span
                          className="h-2 w-2 rounded-full group-hover:hidden"
                          style={{ backgroundColor: 'var(--st-dirty)' }}
                        />
                      ) : null}
                      <X
                        className={`h-3 w-3 ${tab.isDirty ? 'hidden group-hover:block' : 'opacity-40 group-hover:opacity-100'}`}
                      />
                    </button>
                    <span className="truncate flex-1">{tab.name}</span>
                    {tabEnv && tabEnv.kind === 'ssh' && (
                      <span className="text-[11px] font-mono shrink-0" style={{ color: 'var(--st-text-dim)' }}>
                        {tabEnv.name}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Classic Sublime Text 3 "FOLDERS" Header */}
      <div className="flex items-center justify-between gap-1 px-2.5 py-1.5">
        {headerSlot || (
          <span className="st3-section-title truncate">
            Folders · {env.name}
          </span>
        )}

        <div className="flex items-center gap-0.5 shrink-0">
          {extraRightActions}
          <button
            onClick={() => setInlinePrompt({ mode: 'new-file', parentDir: resolvedRoot, value: '' })}
            title="New File"
            className="rounded p-1 hover:bg-white/10"
            style={{ color: 'var(--st-text-dim)' }}
          >
            <FilePlus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setInlinePrompt({ mode: 'new-folder', parentDir: resolvedRoot, value: '' })}
            title="New Folder"
            className="rounded p-1 hover:bg-white/10"
            style={{ color: 'var(--st-text-dim)' }}
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={handleUploadViaPicker}
            title="Upload Files/Folders"
            className="rounded p-1 hover:bg-white/10"
            style={{ color: 'var(--st-text-dim)' }}
          >
            <Upload className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setShowHidden((v) => !v)}
            title={showHidden ? 'Hide Dotfiles' : 'Show Dotfiles'}
            className="rounded p-1 hover:bg-white/10"
            style={{ color: 'var(--st-text-dim)' }}
          >
            {showHidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={() => void loadDirectory(resolvedRoot, true)}
            title="Refresh"
            className="rounded p-1 hover:bg-white/10"
            style={{ color: 'var(--st-text-dim)' }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Slim Path Input Bar */}
      <div className="flex items-center gap-1 px-2 pb-1.5 border-b" style={{ borderColor: 'var(--st-border)' }}>
        <button
          onClick={handleNavigateUp}
          title="Up one folder"
          className="rounded p-1 hover:bg-white/10 shrink-0"
          style={{ color: 'var(--st-text-dim)' }}
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
        <form
          className="flex-1 min-w-0"
          onSubmit={(e) => {
            e.preventDefault()
            if (pathInput.trim()) {
              setEnvRootPath(env.id, pathInput.trim())
              setExpanded(new Set())
            }
          }}
        >
          <input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            className="w-full rounded px-2 py-0.5 font-mono text-[11.5px] outline-none border"
            style={{
              backgroundColor: 'var(--st-input)',
              borderColor: 'var(--st-border)',
              color: 'var(--st-text-muted)'
            }}
          />
        </form>
        {env.kind === 'local' && (
          <button
            onClick={handlePickLocalFolder}
            title="Choose Folder"
            className="rounded px-1.5 py-0.5 text-[11.5px] hover:bg-white/10 shrink-0"
            style={{ color: 'var(--st-text-muted)' }}
          >
            ...
          </button>
        )}
      </div>

      {inlinePrompt && (
        <form
          onSubmit={handleInlineSubmit}
          className="flex items-center gap-1 px-2 py-1.5 border-b"
          style={{ backgroundColor: 'var(--st-panel)', borderColor: 'var(--st-border-light)' }}
        >
          <span className="text-[11px] uppercase font-semibold shrink-0" style={{ color: 'var(--st-accent)' }}>
            {inlinePrompt.mode === 'new-file' ? 'File:' : inlinePrompt.mode === 'new-folder' ? 'Dir:' : 'Rename:'}
          </span>
          <input
            autoFocus
            value={inlinePrompt.value}
            onChange={(e) => setInlinePrompt({ ...inlinePrompt, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setInlinePrompt(null)
            }}
            className="flex-1 min-w-0 rounded px-1.5 py-0.5 font-mono text-[12px] outline-none border"
            style={{ backgroundColor: 'var(--st-input)', borderColor: 'var(--st-border-light)' }}
          />
        </form>
      )}

      {/* Directory Tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {env.kind === 'ssh' && env.status !== 'connected' ? (
          <div className="flex flex-col items-center justify-center gap-2.5 px-4 py-8 text-center text-[12.5px]">
            <div style={{ color: 'var(--st-text-muted)' }}>
              <span className="font-mono font-medium">{env.name}</span> is disconnected
            </div>
            <button
              onClick={async () => {
                const res = await window.multiplex.connectEnvironment(env.id)
                if (!res.ok && res.needsInteractiveAuth) {
                  addToast('info', `Complete login in ${env.name} terminal below`)
                  await ensureTerminalForEnv(env.id)
                } else if (!res.ok && res.error) {
                  addToast('error', res.error)
                }
              }}
              className="rounded px-3.5 py-1.5 text-[12px] font-medium text-[#111]"
              style={{ backgroundColor: 'var(--st-accent)' }}
            >
              Connect {env.name}
            </button>
          </div>
        ) : rootError ? (
          <div className="px-3 py-4 text-[12px] space-y-2">
            <div style={{ color: 'var(--st-red)' }}>{rootError}</div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => void loadDirectory(resolvedRoot, true)}
                className="rounded px-2.5 py-1 text-[11.5px] border hover:bg-white/5"
                style={{ borderColor: 'var(--st-border-light)' }}
              >
                Retry
              </button>
              {rootPath !== '~' && (
                <button
                  onClick={() => setEnvRootPath(env.id, '~')}
                  className="rounded px-2.5 py-1 text-[11.5px] border hover:bg-white/5"
                  style={{ borderColor: 'var(--st-border-light)', color: 'var(--st-accent-blue)' }}
                >
                  Open ~ instead
                </button>
              )}
            </div>
          </div>
        ) : rootEntries.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px]" style={{ color: 'var(--st-text-dim)' }}>
            {loadingDirs.has(resolvedRoot) ? 'Loading...' : 'Empty folder'}
          </div>
        ) : (
          rootEntries.map((entry) => (
            <TreeNodeRow
              key={entry.path}
              env={env}
              entry={entry}
              depth={0}
              expanded={expanded}
              childrenMap={childrenMap}
              loadingDirs={loadingDirs}
              gitStatusMap={envGitStatus[env.id] || {}}
              showHidden={showHidden}
              dragOverPath={dragOverPath}
              onToggleDir={handleToggleDir}
              onOpenFile={(fp) => void openFile(env.id, fp)}
              onContextMenu={(e, ent) => {
                e.preventDefault()
                setContextMenu({ x: e.clientX, y: e.clientY, entry: ent })
              }}
              onDragStartEntry={handleDragStartEntry}
              onDragOverDir={(e, targetDir) => {
                e.preventDefault()
                e.stopPropagation()
                setDragOverPath(targetDir)
              }}
              onDragLeaveDir={(targetDir) => {
                setDragOverPath((prev) => (prev === targetDir ? null : prev))
              }}
              onDropOnDir={(e, targetDir) => void handleDropOnDir(e, targetDir)}
            />
          ))
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="fixed z-50 min-w-[205px] rounded border py-1 shadow-2xl text-[12.5px]"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 220),
            top: Math.min(contextMenu.y, window.innerHeight - 300),
            backgroundColor: 'var(--st-panel)',
            borderColor: 'var(--st-border-light)'
          }}
        >
          {!contextMenu.entry.isDirectory && (
            <>
              <button
                onClick={() => void openFile(env.id, contextMenu.entry.path, undefined, 0)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/10"
              >
                <File className="h-4 w-4" /> Open File
              </button>
              <button
                onClick={() => {
                  useAppStore.getState().setEditorColumns(2)
                  void openFile(env.id, contextMenu.entry.path, undefined, 1)
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/10"
              >
                <FileCode className="h-4 w-4" /> Open in Column 2
              </button>
            </>
          )}

          {env.kind === 'ssh' && (
            <button
              onClick={async () => {
                setShowTransferDrawer(true)
                const tasks = await window.multiplex.downloadToPicker(env.id, [contextMenu.entry.path])
                if (tasks.length > 0) addToast('info', `Downloading ${contextMenu.entry.name}...`)
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/10"
              style={{ color: 'var(--st-accent)' }}
            >
              <Download className="h-4 w-4" /> Download to Mac...
            </button>
          )}

          {env.kind === 'local' && (
            <button
              onClick={() => void window.multiplex.showInFinder(contextMenu.entry.path)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/10"
            >
              <FolderOpen className="h-4 w-4" /> Reveal in Finder
            </button>
          )}

          <button
            onClick={() => {
              const dir = contextMenu.entry.isDirectory
                ? contextMenu.entry.path
                : contextMenu.entry.path.slice(0, contextMenu.entry.path.lastIndexOf('/')) || '/'
              void createTerminalTab(env.id, { cwd: dir })
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/10"
          >
            <Terminal className="h-4 w-4" /> New Terminal Tab Here
          </button>

          <button
            onClick={() => {
              const dir = contextMenu.entry.isDirectory
                ? contextMenu.entry.path
                : contextMenu.entry.path.slice(0, contextMenu.entry.path.lastIndexOf('/')) || '/'
              void splitTerminal(env.id, 'horizontal', dir)
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/10"
          >
            <Terminal className="h-4 w-4" /> Split Terminal Here
          </button>

          <div className="my-1 border-t" style={{ borderColor: 'var(--st-border)' }} />

          <button
            onClick={() =>
              setInlinePrompt({
                mode: 'rename',
                parentDir: resolvedRoot,
                targetEntry: contextMenu.entry,
                value: contextMenu.entry.name
              })
            }
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/10"
          >
            Rename
          </button>
          <button
            onClick={() => {
              void navigator.clipboard.writeText(contextMenu.entry.path)
              addToast('info', 'Copied path')
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/10"
          >
            Copy Path
          </button>
          <button
            onClick={() => void handleDeleteEntry(contextMenu.entry)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/10"
            style={{ color: 'var(--st-red)' }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Unified Sublime Text 3 Sidebar:
 * WORKSPACES + OPEN FILES + FOLDERS (with optional Dual-Tree transfer split).
 */
export const FileTreePanel: React.FC = () => {
  const activeEnvId = useAppStore((s) => s.activeEnvId)
  const dualExplorerEnabled = useAppStore((s) => s.dualExplorerEnabled)
  const setDualExplorerEnabled = useAppStore((s) => s.setDualExplorerEnabled)
  const secondaryEnvId = useAppStore((s) => s.secondaryEnvId)
  const setSecondaryEnvId = useAppStore((s) => s.setSecondaryEnvId)
  const environments = useAppStore((s) => s.environments)

  const dualToggleBtn = (
    <button
      onClick={() => setDualExplorerEnabled(!dualExplorerEnabled)}
      title="Split Explorer into 2 Environments for Drag & Drop Transfer"
      className="rounded p-1 hover:bg-white/10"
      style={{ color: dualExplorerEnabled ? 'var(--st-accent)' : 'var(--st-text-dim)' }}
    >
      <ArrowLeftRight className="h-3.5 w-3.5" />
    </button>
  )

  return (
    <div
      className="flex h-full w-full flex-col border-r"
      style={{ backgroundColor: 'var(--st-sidebar)', borderColor: 'var(--st-border)' }}
    >
      <WorkspaceListSection />

      {!dualExplorerEnabled ? (
        <div className="flex-1 min-h-0">
          <SingleEnvFileTree
            envId={activeEnvId}
            showOpenFilesSection
            extraRightActions={dualToggleBtn}
          />
        </div>
      ) : (
        <div className="flex flex-1 min-h-0 flex-col">
          <div className="flex-1 min-h-0 border-b" style={{ borderColor: 'var(--st-border-light)' }}>
            <SingleEnvFileTree envId={activeEnvId} extraRightActions={dualToggleBtn} />
          </div>
          <div className="flex-1 min-h-0">
            <SingleEnvFileTree
              envId={secondaryEnvId}
              headerSlot={
                <select
                  value={secondaryEnvId}
                  onChange={(e) => setSecondaryEnvId(e.target.value)}
                  className="rounded border px-1.5 py-0.5 text-[11.5px] font-mono outline-none max-w-[145px]"
                  style={{
                    backgroundColor: 'var(--st-input)',
                    borderColor: 'var(--st-border-light)',
                    color: 'var(--st-text)'
                  }}
                >
                  {environments.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              }
            />
          </div>
        </div>
      )}
    </div>
  )
}
