import { BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import type {
  CustomHostInput,
  Environment,
  SearchRequest,
  TerminalCreateOptions,
  TransferRequest
} from '@shared/types'
import { IPC } from '@shared/ipc'
import { parseMacOsFilenamesPlist } from '@shared/terminalKeymap'
import type { EnvironmentRegistry } from '../ssh/configParser'
import { setConfiguredExtraPathDirs, type SshControlMaster } from '../ssh/controlMaster'
import type { TerminalManager } from '../terminal/terminalManager'
import type { UnifiedVfs } from '../fs/vfs'
import type { TransferManager } from '../fs/transferManager'
import type { SearchManager } from '../search/searchManager'

export interface MainServices {
  registry: EnvironmentRegistry
  controlMaster: SshControlMaster
  terminalManager: TerminalManager
  vfs: UnifiedVfs
  transferManager: TransferManager
  searchManager: SearchManager
  getMainWindow: () => BrowserWindow | null
}

const DRAG_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAQklEQVR42mNgGGjACMR/GZDApwH1/4MwA8M/BiQQj4yGGA0wGgADyQ0Y5gAGhgEMjIwaMDIMGB4wGsBA00gAAgAAg3gO2nW68+YAAAAASUVORK5CYII='

export function registerIpcHandlers(services: MainServices): void {
  const { registry, controlMaster, terminalManager, vfs, transferManager, searchManager, getMainWindow } = services

  const requireEnv = (envId: string): Environment => {
    const env = registry.get(envId)
    if (!env) throw new Error(`Environment not found: ${envId}`)
    return env
  }

  const broadcastEnvStatus = (env: Environment) => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.ENV_STATUS_CHANGED, env)
    }
  }

  const broadcastConfigUpdated = () => {
    const reloaded = registry.reloadFromDisk()
    setConfiguredExtraPathDirs(registry.getExtraPathDirs())
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.CONFIG_UPDATED, reloaded)
    }
    return reloaded
  }

  // --- Config & Environments ---
  ipcMain.handle(IPC.CONFIG_GET_PATH, () => ({
    configPath: registry.getConfigPath(),
    theme: registry.getTheme(),
    editorFontSize: registry.getEditorFontSize(),
    terminalFontSize: registry.getTerminalFontSize()
  }))

  ipcMain.handle(IPC.CONFIG_RELOAD, () => broadcastConfigUpdated())

  ipcMain.handle(IPC.ENV_LIST, () => registry.list())
  ipcMain.handle(IPC.ENV_LIST_SSH_CONFIG, () => registry.listSshConfigHosts())
  ipcMain.handle(IPC.ENV_REFRESH, () => registry.refresh())

  ipcMain.handle(IPC.ENV_ADD_CUSTOM, (_e, input: CustomHostInput) => {
    return registry.addOrUpdateCustom(input)
  })

  ipcMain.handle(IPC.ENV_DELETE_CUSTOM, async (_e, envId: string) => {
    const env = registry.get(envId)
    if (env && env.kind === 'ssh') {
      terminalManager.killAllForEnv(envId)
      vfs.disposeEnv(envId)
      await controlMaster.disconnect(env)
    }
    registry.deleteCustom(envId)
    return registry.list()
  })

  ipcMain.handle(IPC.ENV_UPDATE_SETTINGS, (_e, envId: string, patch: any) => {
    const updated = registry.updateSettings(envId, patch)
    if (updated) broadcastEnvStatus(updated)
    return updated
  })

  ipcMain.handle(IPC.ENV_CONNECT, async (_e, envId: string) => {
    const env = requireEnv(envId)
    // Always re-read from the registry before broadcasting: a config reload during the (slow) dial
    // replaces the env objects, and broadcasting the stale one left the UI stuck on "connecting".
    const latest = () => registry.get(envId) || env
    if (env.kind === 'local') {
      registry.setStatus(envId, 'connected')
      broadcastEnvStatus(latest())
      return { ok: true, env: latest() }
    }

    registry.setStatus(envId, 'connecting')
    broadcastEnvStatus(latest())

    const result = await controlMaster.connect(latest())
    if (result.ok) {
      registry.setStatus(envId, 'connected', undefined)
      broadcastEnvStatus(latest())
      return { ok: true, env: latest() }
    }

    registry.setStatus(
      envId,
      result.needsInteractiveAuth ? 'disconnected' : 'error',
      result.needsInteractiveAuth ? 'Interactive auth required — login in terminal' : result.error
    )
    broadcastEnvStatus(latest())
    return { ok: false, needsInteractiveAuth: result.needsInteractiveAuth, error: result.error, env: latest() }
  })

  ipcMain.handle(IPC.ENV_DISCONNECT, async (_e, envId: string) => {
    const env = requireEnv(envId)
    if (env.kind === 'ssh') {
      // Preserve terminal panes & xterm scrollback instead of destroying them!
      terminalManager.disconnectEnv(envId)
      vfs.disposeEnv(envId)
      await controlMaster.disconnect(env)
      registry.setStatus(envId, 'disconnected', undefined)
      broadcastEnvStatus(env)
    }
    return env
  })

  ipcMain.handle(IPC.ENV_GET_HOME, async (_e, envId: string) => {
    const env = requireEnv(envId)
    return controlMaster.resolveHomeDir(env)
  })

  ipcMain.handle(IPC.ENV_GET_GIT_BRANCH, async (_e, envId: string, dirPath: string) => {
    const env = requireEnv(envId)
    return vfs.getGitBranch(env, dirPath)
  })

  ipcMain.handle(IPC.ENV_GET_GIT_STATUS, async (_e, envId: string, dirPath: string) => {
    const env = requireEnv(envId)
    return vfs.getGitStatus(env, dirPath)
  })

  // --- Terminals ---
  ipcMain.handle(IPC.TERM_CREATE, (_e, options: TerminalCreateOptions) => {
    const env = requireEnv(options.envId)
    return terminalManager.create(env, options)
  })

  ipcMain.on(IPC.TERM_WRITE, (_e, terminalId: string, data: string) => {
    terminalManager.write(terminalId, data)
  })

  ipcMain.on(IPC.TERM_READY, (_e, terminalId: string) => {
    terminalManager.markRendererReady(terminalId)
  })

  ipcMain.on(IPC.TERM_RESIZE, (_e, terminalId: string, cols: number, rows: number) => {
    terminalManager.resize(terminalId, cols, rows)
  })

  ipcMain.handle(IPC.TERM_KILL, (_e, terminalId: string) => {
    terminalManager.kill(terminalId, { destroyRemoteSession: true })
  })

  ipcMain.handle(IPC.TERM_RECONNECT, async (_e, terminalId: string, forceReset = true) => {
    await terminalManager.reconnect(terminalId, { forceReset })
  })

  ipcMain.handle(IPC.TERM_PAUSE_RECONNECT, (_e, terminalId: string) => {
    terminalManager.pauseReconnect(terminalId)
  })

  ipcMain.handle(IPC.TERM_RECONNECT_ALL, async (_e, force = false) => {
    await terminalManager.handleSystemResume({ force: Boolean(force) })
  })

  ipcMain.handle(IPC.TERM_LIST_RECOVERABLE_TMUX, async (_e, envId: string, maxAgeSec = 3600) => {
    const env = requireEnv(envId)
    return terminalManager.listRecoverableTmuxSessions(env, maxAgeSec)
  })

  ipcMain.handle(IPC.TERM_LIST_TMUX, async (_e, envId: string) => {
    const env = requireEnv(envId)
    return terminalManager.listTmuxSessions(env)
  })

  ipcMain.handle(IPC.TERM_SWITCH_TMUX, async (_e, terminalId: string, targetSession?: string) => {
    return terminalManager.switchTmuxSession(terminalId, targetSession)
  })

  ipcMain.handle(IPC.TERM_KILL_TMUX, async (_e, envId: string, sessionName: string) => {
    const env = requireEnv(envId)
    return terminalManager.killTmuxSession(env, sessionName)
  })

  ipcMain.handle(IPC.TERM_PRUNE_TMUX, async (_e, envId: string, minAgeSec = 3600) => {
    const env = requireEnv(envId)
    return terminalManager.pruneStaleTmuxSessions(env, minAgeSec)
  })

  // --- Unified VFS ---
  ipcMain.handle(IPC.FS_READ_DIR, async (_e, envId: string, dirPath: string) => {
    const env = requireEnv(envId)
    if (env.kind === 'ssh' && env.status !== 'connected') {
      const ok = await controlMaster.ensureConnected(env)
      if (ok) {
        registry.setStatus(envId, 'connected', undefined)
        broadcastEnvStatus(env)
      }
    }
    const normalized = await vfs.normalizePath(env, dirPath)
    const entries = await vfs.readDir(env, normalized)
    return { path: normalized, entries }
  })

  ipcMain.handle(IPC.FS_STAT, async (_e, envId: string, targetPath: string) => {
    return vfs.stat(requireEnv(envId), targetPath)
  })

  ipcMain.handle(IPC.FS_READ_FILE, async (_e, envId: string, filePath: string) => {
    return vfs.readFile(requireEnv(envId), filePath)
  })

  ipcMain.handle(IPC.FS_WRITE_FILE, async (_e, envId: string, filePath: string, content: string) => {
    const env = requireEnv(envId)
    await vfs.writeFile(env, filePath, content)
    if (env.kind === 'local') {
      const normSaved = path.resolve(await vfs.normalizePath(env, filePath))
      const normCfg = path.resolve(registry.getConfigPath())
      if (normSaved === normCfg) {
        broadcastConfigUpdated()
      }
    }
    return { ok: true }
  })

  ipcMain.handle(IPC.FS_MKDIR, async (_e, envId: string, dirPath: string) => {
    await vfs.mkdir(requireEnv(envId), dirPath)
    return { ok: true }
  })

  ipcMain.handle(IPC.FS_CREATE_FILE, async (_e, envId: string, filePath: string) => {
    await vfs.createFile(requireEnv(envId), filePath)
    return { ok: true }
  })

  ipcMain.handle(IPC.FS_RENAME, async (_e, envId: string, oldPath: string, newPath: string) => {
    await vfs.rename(requireEnv(envId), oldPath, newPath)
    return { ok: true }
  })

  ipcMain.handle(IPC.FS_DELETE, async (_e, envId: string, targetPath: string) => {
    await vfs.deleteEntry(requireEnv(envId), targetPath)
    return { ok: true }
  })

  ipcMain.handle(IPC.FS_PICK_LOCAL_DIR, async () => {
    const win = getMainWindow()
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : res.filePaths[0] ?? null
  })

  ipcMain.handle(IPC.FS_PICK_LOCAL_FILES, async () => {
    const win = getMainWindow()
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openFile', 'openDirectory', 'multiSelections']
    })
    return res.canceled ? [] : res.filePaths
  })

  ipcMain.handle(IPC.FS_SHOW_IN_FINDER, (_e, localPath: string) => {
    shell.showItemInFolder(localPath)
  })

  ipcMain.handle(IPC.FS_START_NATIVE_DRAG, async (event, envId: string, filePath: string) => {
    const env = requireEnv(envId)
    const localEnv: Environment = registry.get('local') || {
      id: 'local',
      kind: 'local',
      name: 'Local Mac',
      defaultPath: '/',
      color: '#66d9ef',
      useTmux: false,
      source: 'config',
      status: 'connected'
    }
    const localFilePath = await transferManager.stageForFinderDrag(env, filePath, localEnv)
    const icon = nativeImage.createFromDataURL(DRAG_ICON_DATA_URL)
    event.sender.startDrag({
      file: localFilePath,
      icon
    })
    return { ok: true, stagedPath: localFilePath }
  })

  // --- Transfers ---
  ipcMain.handle(IPC.TRANSFER_ENQUEUE, async (_e, req: TransferRequest) => {
    const sourceEnv = requireEnv(req.sourceEnvId)
    const targetEnv = requireEnv(req.targetEnvId)
    return transferManager.enqueue(sourceEnv, targetEnv, req)
  })

  ipcMain.handle(IPC.TRANSFER_CANCEL, (_e, taskId: string) => {
    transferManager.cancel(taskId)
  })

  ipcMain.handle(IPC.TRANSFER_LIST, () => transferManager.list())
  ipcMain.handle(IPC.TRANSFER_CLEAR_FINISHED, () => {
    transferManager.clearFinished()
    return transferManager.list()
  })

  ipcMain.handle(IPC.TRANSFER_DOWNLOAD_TO_PICKER, async (_e, sourceEnvId: string, sourcePaths: string[]) => {
    const win = getMainWindow()
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      title: 'Select Destination Folder on Mac',
      buttonLabel: 'Download Here',
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths[0]) return []
    const targetDir = res.filePaths[0]
    const sourceEnv = requireEnv(sourceEnvId)
    const localEnv = requireEnv('local')
    const tasks = []
    for (const sp of sourcePaths) {
      tasks.push(
        await transferManager.enqueue(sourceEnv, localEnv, {
          sourceEnvId,
          sourcePath: sp,
          targetEnvId: 'local',
          targetDir
        })
      )
    }
    return tasks
  })

  // --- Global Search & Quick Open (Goto Files) ---
  ipcMain.handle(IPC.SEARCH_START, async (_e, req: SearchRequest) => {
    void searchManager.startSearch(req, (id) => registry.get(id))
    return { started: true }
  })

  ipcMain.handle(IPC.SEARCH_CANCEL, (_e, searchId: string) => {
    searchManager.cancel(searchId)
  })

  ipcMain.handle(IPC.SEARCH_LIST_FILES, async (_e, envId: string, rootPath: string) => {
    const env = requireEnv(envId)
    return searchManager.listFiles(env, rootPath)
  })

  ipcMain.handle(
    IPC.SEARCH_FILES_QUERY,
    async (_e, envId: string, rootPath: string, query: string, requestId: string, limit?: number) => {
      const env = requireEnv(envId)
      return searchManager.searchFiles(env, rootPath, query, { requestId, limit })
    }
  )

  ipcMain.handle(IPC.SEARCH_FILES_CANCEL, (_e, requestId: string) => {
    searchManager.cancelFileQuery(requestId)
  })

  // --- System Clipboard & Native Edit ---
  const shellQuotePath = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`

  const readFinderFilePaths = (): string[] => {
    if (process.platform !== 'darwin') return []
    const found: string[] = []
    try {
      const plistBuf = clipboard.readBuffer('NSFilenamesPboardType')
      if (plistBuf && plistBuf.length > 0) {
        const parsed = parseMacOsFilenamesPlist(plistBuf.toString('utf8'))
        for (const p of parsed) {
          if (fs.existsSync(p)) found.push(p)
        }
      }
    } catch {
      // ignore
    }
    if (found.length > 0) return found
    try {
      const rawUrl = clipboard.read('public.file-url')?.trim()
      if (rawUrl && rawUrl.startsWith('file://')) {
        const localPath = fileURLToPath(rawUrl)
        if (localPath && fs.existsSync(localPath)) {
          found.push(localPath)
        }
      }
    } catch {
      // ignore
    }
    return found
  }

  ipcMain.on(IPC.CLIPBOARD_READ_TEXT, (event) => {
    event.returnValue = clipboard.readText()
  })

  ipcMain.handle(IPC.CLIPBOARD_READ_FOR_TERMINAL, async (_event, envId: string) => {
    const env = registry.get(envId)
    const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i
    const MAX_CLIP_IMAGE_BYTES = 20 * 1024 * 1024

    // 1. macOS Finder copied files (`⌘C` in Finder -> `⌘V` in terminal)
    const finderPaths = readFinderFilePaths()
    if (finderPaths.length > 0) {
      if (!env || env.kind === 'local') {
        return {
          kind: 'files' as const,
          text: finderPaths.map(shellQuotePath).join(' ') + ' ',
          count: finderPaths.length
        }
      }
      // On SSH env: if user copied a single small image file in Finder, upload it straight to remote /tmp/!
      if (finderPaths.length === 1 && IMAGE_EXT_RE.test(finderPaths[0])) {
        try {
          const st = await fsp.stat(finderPaths[0])
          if (st.isFile() && st.size > 0 && st.size <= MAX_CLIP_IMAGE_BYTES) {
            const connected = await controlMaster.isConnected(env)
            if (connected) {
              const ext = path.extname(finderPaths[0]).toLowerCase() || '.png'
              const remotePath = `/tmp/mide-clip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`
              const buf = await fsp.readFile(finderPaths[0])
              await vfs.writeBuffer(env, remotePath, buf)
              return {
                kind: 'image' as const,
                text: `${shellQuotePath(remotePath)} `,
                targetPath: remotePath,
                sizeBytes: buf.length,
                uploadedTo: env.name
              }
            }
          }
        } catch (err: any) {
          return {
            kind: 'error' as const,
            text: '',
            error: `Failed to upload image to ${env.name}: ${err?.message || err}`
          }
        }
      }
    }

    // 2. Standard plain text (99% fast path)
    const text = clipboard.readText()
    if (text) {
      return { kind: 'text' as const, text }
    }

    // 3. Clipboard screenshot / image (`⌘⌃⇧4`, Feishu/WeChat screenshot -> `⌘V` in `agy`!)
    try {
      const img = clipboard.readImage()
      if (img && !img.isEmpty()) {
        const pngBuf = img.toPNG()
        if (pngBuf.length === 0) return { kind: 'empty' as const, text: '' }
        if (pngBuf.length > MAX_CLIP_IMAGE_BYTES) {
          return {
            kind: 'error' as const,
            text: '',
            error: `Clipboard image is too large (${(pngBuf.length / 1024 / 1024).toFixed(1)} MB)`
          }
        }
        const fileName = `mide-clip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`
        if (!env || env.kind === 'local') {
          const tmpDir = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir()
          const targetPath = path.join(tmpDir, fileName)
          await fsp.writeFile(targetPath, pngBuf)
          return {
            kind: 'image' as const,
            text: `${shellQuotePath(targetPath)} `,
            targetPath,
            sizeBytes: pngBuf.length
          }
        }
        const connected = await controlMaster.isConnected(env)
        if (!connected) {
          return {
            kind: 'error' as const,
            text: '',
            error: `${env.name} is not connected — cannot upload clipboard screenshot`
          }
        }
        const remotePath = `/tmp/${fileName}`
        await vfs.writeBuffer(env, remotePath, pngBuf)
        return {
          kind: 'image' as const,
          text: `${shellQuotePath(remotePath)} `,
          targetPath: remotePath,
          sizeBytes: pngBuf.length,
          uploadedTo: env.name
        }
      }
    } catch (err: any) {
      return {
        kind: 'error' as const,
        text: '',
        error: `Clipboard image paste failed: ${err?.message || err}`
      }
    }

    return { kind: 'empty' as const, text: '' }
  })

  ipcMain.on(IPC.CLIPBOARD_WRITE_TEXT, (_event, text: string) => {
    clipboard.writeText(typeof text === 'string' ? text : '')
  })

  ipcMain.on(IPC.CLIPBOARD_NATIVE_EDIT, (event, action: 'cut' | 'copy' | 'paste' | 'selectAll') => {
    const sender = event.sender
    if (!sender || sender.isDestroyed()) return
    if (action === 'copy') sender.copy()
    else if (action === 'cut') sender.cut()
    else if (action === 'paste') sender.paste()
    else if (action === 'selectAll') sender.selectAll()
  })
}
