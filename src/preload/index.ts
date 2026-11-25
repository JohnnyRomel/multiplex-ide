import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  CustomHostInput,
  EditorThemeId,
  Environment,
  FileEntry,
  FileReadResult,
  GitStatusEntry,
  QuickOpenFile,
  SearchDoneEvent,
  SearchMatch,
  SearchRequest,
  SshConfigHostSummary,
  TerminalCreateOptions,
  TerminalNotification,
  TerminalSessionInfo,
  TerminalStatusEvent,
  TransferRequest,
  TransferTask
} from '@shared/types'

const api = {
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  // System Clipboard & Native Edit
  readClipboardText: (): string => {
    const val = ipcRenderer.sendSync(IPC.CLIPBOARD_READ_TEXT)
    return typeof val === 'string' ? val : ''
  },
  writeClipboardText: (text: string): void => {
    ipcRenderer.send(IPC.CLIPBOARD_WRITE_TEXT, text)
  },
  execNativeEdit: (action: 'cut' | 'copy' | 'paste' | 'selectAll'): void => {
    ipcRenderer.send(IPC.CLIPBOARD_NATIVE_EDIT, action)
  },
  onClipboardAction: (cb: (action: 'cut' | 'copy' | 'paste' | 'selectAll') => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, action: 'cut' | 'copy' | 'paste' | 'selectAll') => cb(action)
    ipcRenderer.on(IPC.CLIPBOARD_ACTION, handler)
    return () => ipcRenderer.removeListener(IPC.CLIPBOARD_ACTION, handler)
  },

  // Config & Environments
  getConfigInfo: (): Promise<{
    configPath: string
    theme: EditorThemeId
    editorFontSize: number
    terminalFontSize: number
  }> => ipcRenderer.invoke(IPC.CONFIG_GET_PATH),
  reloadConfig: (): Promise<{
    environments: Environment[]
    theme: EditorThemeId
    editorFontSize: number
    terminalFontSize: number
  }> => ipcRenderer.invoke(IPC.CONFIG_RELOAD),
  onConfigUpdated: (
    cb: (payload: {
      environments: Environment[]
      theme: EditorThemeId
      editorFontSize?: number
      terminalFontSize?: number
    }) => void
  ): (() => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      payload: {
        environments: Environment[]
        theme: EditorThemeId
        editorFontSize?: number
        terminalFontSize?: number
      }
    ) => cb(payload)
    ipcRenderer.on(IPC.CONFIG_UPDATED, handler)
    return () => ipcRenderer.removeListener(IPC.CONFIG_UPDATED, handler)
  },

  listEnvironments: (): Promise<Environment[]> => ipcRenderer.invoke(IPC.ENV_LIST),
  listSshConfigHosts: (): Promise<SshConfigHostSummary[]> => ipcRenderer.invoke(IPC.ENV_LIST_SSH_CONFIG),
  refreshEnvironments: (): Promise<Environment[]> => ipcRenderer.invoke(IPC.ENV_REFRESH),
  addCustomHost: (input: CustomHostInput): Promise<Environment> => ipcRenderer.invoke(IPC.ENV_ADD_CUSTOM, input),
  deleteCustomHost: (envId: string): Promise<Environment[]> => ipcRenderer.invoke(IPC.ENV_DELETE_CUSTOM, envId),
  updateEnvSettings: (
    envId: string,
    patch: Partial<Environment> & {
      theme?: EditorThemeId
      editorFontSize?: number
      terminalFontSize?: number
    }
  ): Promise<Environment | undefined> => ipcRenderer.invoke(IPC.ENV_UPDATE_SETTINGS, envId, patch),
  connectEnvironment: (envId: string): Promise<{ ok: boolean; needsInteractiveAuth?: boolean; error?: string; env: Environment }> =>
    ipcRenderer.invoke(IPC.ENV_CONNECT, envId),
  disconnectEnvironment: (envId: string): Promise<Environment> => ipcRenderer.invoke(IPC.ENV_DISCONNECT, envId),
  getEnvHome: (envId: string): Promise<string> => ipcRenderer.invoke(IPC.ENV_GET_HOME, envId),
  getGitBranch: (envId: string, dirPath: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.ENV_GET_GIT_BRANCH, envId, dirPath),
  getGitStatus: (envId: string, dirPath: string): Promise<GitStatusEntry[]> =>
    ipcRenderer.invoke(IPC.ENV_GET_GIT_STATUS, envId, dirPath),
  onEnvStatusChanged: (cb: (env: Environment) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, env: Environment) => cb(env)
    ipcRenderer.on(IPC.ENV_STATUS_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC.ENV_STATUS_CHANGED, handler)
  },

  // Terminals
  createTerminal: (options: TerminalCreateOptions): Promise<TerminalSessionInfo> =>
    ipcRenderer.invoke(IPC.TERM_CREATE, options),
  writeTerminal: (terminalId: string, data: string): void => {
    ipcRenderer.send(IPC.TERM_WRITE, terminalId, data)
  },
  resizeTerminal: (terminalId: string, cols: number, rows: number): void => {
    ipcRenderer.send(IPC.TERM_RESIZE, terminalId, cols, rows)
  },
  killTerminal: (terminalId: string): Promise<void> => ipcRenderer.invoke(IPC.TERM_KILL, terminalId),
  reconnectTerminal: (terminalId: string, forceReset = true): Promise<void> =>
    ipcRenderer.invoke(IPC.TERM_RECONNECT, terminalId, forceReset),
  pauseTerminalReconnect: (terminalId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.TERM_PAUSE_RECONNECT, terminalId),
  reconnectAllTerminals: (): Promise<void> => ipcRenderer.invoke(IPC.TERM_RECONNECT_ALL),
  onTerminalData: (cb: (terminalId: string, data: string) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, terminalId: string, data: string) => cb(terminalId, data)
    ipcRenderer.on(IPC.TERM_DATA, handler)
    return () => ipcRenderer.removeListener(IPC.TERM_DATA, handler)
  },
  onTerminalExit: (cb: (terminalId: string, envId: string, exitCode: number) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, terminalId: string, envId: string, exitCode: number) =>
      cb(terminalId, envId, exitCode)
    ipcRenderer.on(IPC.TERM_EXIT, handler)
    return () => ipcRenderer.removeListener(IPC.TERM_EXIT, handler)
  },
  onTerminalStatus: (cb: (status: TerminalStatusEvent) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, status: TerminalStatusEvent) => cb(status)
    ipcRenderer.on(IPC.TERM_STATUS, handler)
    return () => ipcRenderer.removeListener(IPC.TERM_STATUS, handler)
  },
  onTerminalNotification: (cb: (notification: TerminalNotification) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, n: TerminalNotification) => cb(n)
    ipcRenderer.on(IPC.TERM_NOTIFICATION, handler)
    return () => ipcRenderer.removeListener(IPC.TERM_NOTIFICATION, handler)
  },

  // File System (VFS)
  readDir: (envId: string, dirPath: string): Promise<{ path: string; entries: FileEntry[] }> =>
    ipcRenderer.invoke(IPC.FS_READ_DIR, envId, dirPath),
  statFile: (envId: string, filePath: string): Promise<FileEntry> => ipcRenderer.invoke(IPC.FS_STAT, envId, filePath),
  readFile: (envId: string, filePath: string): Promise<FileReadResult> =>
    ipcRenderer.invoke(IPC.FS_READ_FILE, envId, filePath),
  writeFile: (envId: string, filePath: string, content: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.FS_WRITE_FILE, envId, filePath, content),
  mkdir: (envId: string, dirPath: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.FS_MKDIR, envId, dirPath),
  createFile: (envId: string, filePath: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.FS_CREATE_FILE, envId, filePath),
  renameEntry: (envId: string, oldPath: string, newPath: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.FS_RENAME, envId, oldPath, newPath),
  deleteEntry: (envId: string, targetPath: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.FS_DELETE, envId, targetPath),
  pickLocalDir: (): Promise<string | null> => ipcRenderer.invoke(IPC.FS_PICK_LOCAL_DIR),
  pickLocalFiles: (): Promise<string[]> => ipcRenderer.invoke(IPC.FS_PICK_LOCAL_FILES),
  showInFinder: (localPath: string): Promise<void> => ipcRenderer.invoke(IPC.FS_SHOW_IN_FINDER, localPath),
  startNativeDrag: (envId: string, filePath: string): Promise<{ ok: boolean; stagedPath: string }> =>
    ipcRenderer.invoke(IPC.FS_START_NATIVE_DRAG, envId, filePath),

  // Transfers
  enqueueTransfer: (req: TransferRequest): Promise<TransferTask> => ipcRenderer.invoke(IPC.TRANSFER_ENQUEUE, req),
  cancelTransfer: (taskId: string): Promise<void> => ipcRenderer.invoke(IPC.TRANSFER_CANCEL, taskId),
  listTransfers: (): Promise<TransferTask[]> => ipcRenderer.invoke(IPC.TRANSFER_LIST),
  clearFinishedTransfers: (): Promise<TransferTask[]> => ipcRenderer.invoke(IPC.TRANSFER_CLEAR_FINISHED),
  downloadToPicker: (sourceEnvId: string, sourcePaths: string[]): Promise<TransferTask[]> =>
    ipcRenderer.invoke(IPC.TRANSFER_DOWNLOAD_TO_PICKER, sourceEnvId, sourcePaths),
  onTransferUpdate: (cb: (task: TransferTask) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, task: TransferTask) => cb(task)
    ipcRenderer.on(IPC.TRANSFER_UPDATE, handler)
    return () => ipcRenderer.removeListener(IPC.TRANSFER_UPDATE, handler)
  },

  // Global Search & Quick Open (Goto Files)
  startSearch: (req: SearchRequest): Promise<{ started: boolean }> => ipcRenderer.invoke(IPC.SEARCH_START, req),
  cancelSearch: (searchId: string): Promise<void> => ipcRenderer.invoke(IPC.SEARCH_CANCEL, searchId),
  listFiles: (envId: string, rootPath: string): Promise<QuickOpenFile[]> =>
    ipcRenderer.invoke(IPC.SEARCH_LIST_FILES, envId, rootPath),
  searchFilesQuery: (
    envId: string,
    rootPath: string,
    query: string,
    requestId: string,
    limit?: number
  ): Promise<QuickOpenFile[]> =>
    ipcRenderer.invoke(IPC.SEARCH_FILES_QUERY, envId, rootPath, query, requestId, limit),
  cancelFileSearch: (requestId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.SEARCH_FILES_CANCEL, requestId),
  onSearchMatchBatch: (cb: (matches: SearchMatch[]) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, matches: SearchMatch[]) => cb(matches)
    ipcRenderer.on(IPC.SEARCH_MATCH_BATCH, handler)
    return () => ipcRenderer.removeListener(IPC.SEARCH_MATCH_BATCH, handler)
  },
  onSearchDone: (cb: (done: SearchDoneEvent) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, done: SearchDoneEvent) => cb(done)
    ipcRenderer.on(IPC.SEARCH_DONE, handler)
    return () => ipcRenderer.removeListener(IPC.SEARCH_DONE, handler)
  }
}

export type MultiplexAPI = typeof api

contextBridge.exposeInMainWorld('multiplex', api)
