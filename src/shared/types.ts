export type EnvironmentKind = 'local' | 'ssh'
export type EnvironmentStatus = 'disconnected' | 'connecting' | 'connected' | 'error'
export type EnvironmentSource = 'config' | 'ssh-config' | 'custom'
export type EditorThemeId = 'monokai' | 'mariana' | 'boxy'
export type TerminalConnState = 'connected' | 'connecting' | 'reconnecting' | 'disconnected'

export interface WorkspaceConfigEntry {
  id?: string
  name: string
  kind: EnvironmentKind
  host?: string
  hostname?: string
  user?: string
  port?: number
  proxyJump?: string
  identityFile?: string
  defaultPath?: string
  color?: string
  useTmux?: boolean
  tmuxSessionName?: string
  pinned?: boolean
}

export interface MultiplexConfigFile {
  theme?: EditorThemeId
  editorFontSize?: number
  terminalFontSize?: number
  showAllSshConfigHosts?: boolean
  extraPathDirs?: string[]
  workspaces: WorkspaceConfigEntry[]
}

export interface Environment {
  id: string
  kind: EnvironmentKind
  name: string
  host?: string
  hostname?: string
  user?: string
  port?: number
  proxyJump?: string
  identityFile?: string
  defaultPath: string
  color: string
  useTmux: boolean
  tmuxSessionName?: string
  pinned?: boolean
  source: EnvironmentSource
  status: EnvironmentStatus
  statusMessage?: string
}

export interface SshConfigHostSummary {
  alias: string
  hostname?: string
  user?: string
  port?: number
  proxyJump?: string
  identityFile?: string
}

export interface CustomHostInput {
  id?: string
  name: string
  host: string
  hostname?: string
  user?: string
  port?: number
  proxyJump?: string
  identityFile?: string
  defaultPath?: string
  color?: string
  useTmux?: boolean
  tmuxSessionName?: string
}

export interface TerminalCreateOptions {
  envId: string
  cwd?: string
  cols?: number
  rows?: number
  title?: string
  useTmux?: boolean
  tmuxSession?: string
  attachRecentTmux?: boolean
  recentMaxAgeSec?: number
}

export interface RecoverableTmuxSession {
  name: string
  ageSec: number
  lastActivityEpoch: number
  attached: number
  command: string
  cwd?: string
  windows?: number
  size?: string
  isManaged?: boolean
  ownedByApp?: boolean
}

export interface TerminalSessionInfo {
  id: string
  envId: string
  title: string
  cwd?: string
  cols: number
  rows: number
  createdAt: number
  tmuxSession?: string
}

export interface TerminalStatusEvent {
  terminalId: string
  envId: string
  state: TerminalConnState
  exitCode?: number
  attempt?: number
  maxAttempts?: number
  nextRetryMs?: number
  message?: string
  tmuxSession?: string
}

export interface TerminalNotification {
  terminalId: string
  envId: string
  kind: 'osc' | 'bell'
  title?: string
  body?: string
  timestamp: number
}

export interface FileEntry {
  name: string
  path: string
  envId: string
  isDirectory: boolean
  isSymlink: boolean
  size: number
  mtimeMs: number
  permissions?: string
}

export interface FileReadResult {
  envId: string
  path: string
  content: string
  size: number
  isBinary: boolean
  mtimeMs: number
}

export interface SearchTarget {
  envId: string
  rootPath: string
}

export interface SearchRequest {
  searchId: string
  query: string
  targets: SearchTarget[]
  isRegex?: boolean
  isCaseSensitive?: boolean
  wholeWord?: boolean
  includeGlob?: string
  excludeGlob?: string
  maxResults?: number
}

export interface SearchMatch {
  searchId: string
  envId: string
  filePath: string
  relativePath: string
  line: number
  column: number
  matchLength: number
  lineText: string
}

export interface SearchDoneEvent {
  searchId: string
  totalMatches: number
  truncated: boolean
  errors: Array<{ envId: string; message: string }>
  durationMs: number
}

export interface QuickOpenFile {
  envId: string
  filePath: string
  relativePath: string
  name: string
}

export type TransferDirection = 'upload' | 'download' | 'cross-env'
export type TransferStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface TransferRequest {
  sourceEnvId: string
  sourcePath: string
  targetEnvId: string
  targetDir: string
  overwrite?: boolean
}

export interface TransferTask {
  id: string
  direction: TransferDirection
  sourceEnvId: string
  sourcePath: string
  targetEnvId: string
  targetDir: string
  itemName: string
  isDirectory: boolean
  status: TransferStatus
  bytesTransferred: number
  totalBytes: number
  filesCompleted: number
  totalFiles: number
  speedBps: number
  error?: string
  createdAt: number
  finishedAt?: number
}

export interface GitStatusEntry {
  path: string
  status: string
}

export type LayoutMode = 'ide' | 'terminal' | 'transfer'
