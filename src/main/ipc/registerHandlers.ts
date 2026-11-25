import { BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import path from 'path'
import type {
  CustomHostInput,
  Environment,
  SearchRequest,
  TerminalCreateOptions,
  TransferRequest
} from '@shared/types'
import { IPC } from '@shared/ipc'
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
    if (env.kind === 'local') {
      registry.setStatus(envId, 'connected')
      broadcastEnvStatus(env)
      return { ok: true, env }
    }

    registry.setStatus(envId, 'connecting')
    broadcastEnvStatus(env)

    const result = await controlMaster.connect(env)
    if (result.ok) {
      registry.setStatus(envId, 'connected', undefined)
      broadcastEnvStatus(env)
      return { ok: true, env }
    }

    registry.setStatus(
      envId,
      result.needsInteractiveAuth ? 'disconnected' : 'error',
      result.needsInteractiveAuth ? 'Interactive auth required — login in terminal' : result.error
    )
    broadcastEnvStatus(env)
    return { ok: false, needsInteractiveAuth: result.needsInteractiveAuth, error: result.error, env }
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

  ipcMain.on(IPC.TERM_RESIZE, (_e, terminalId: string, cols: number, rows: number) => {
    terminalManager.resize(terminalId, cols, rows)
  })

  ipcMain.handle(IPC.TERM_KILL, (_e, terminalId: string) => {
    terminalManager.kill(terminalId, { destroyRemoteSession: true })
  })

  ipcMain.handle(IPC.TERM_RECONNECT, async (_e, terminalId: string, forceReset = true) => {
    await terminalManager.reconnect(terminalId, { forceReset })
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
  ipcMain.on(IPC.CLIPBOARD_READ_TEXT, (event) => {
    event.returnValue = clipboard.readText()
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
