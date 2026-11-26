import { create } from 'zustand'
import type {
  EditorThemeId,
  Environment,
  LayoutMode,
  RecoverableTmuxSession,
  SearchDoneEvent,
  SearchMatch,
  TerminalNotification,
  TerminalStatusEvent,
  TransferTask
} from '@shared/types'

export type TerminalSplitNode =
  | { type: 'leaf'; paneId: string; terminalId: string; title: string }
  | { type: 'split'; id: string; direction: 'horizontal' | 'vertical'; children: TerminalSplitNode[] }

export interface TerminalTab {
  id: string
  envId: string
  title: string
  root: TerminalSplitNode
  focusedPaneId?: string
  hasUnread?: boolean
}

export interface EditorTab {
  id: string
  envId: string
  path: string
  name: string
  language: string
  content: string
  savedContent: string
  isDirty: boolean
  isBinary: boolean
  loading: boolean
  error?: string
  /** Set for non-UTF-8 files: shown decoded but never saved back (would corrupt the bytes) */
  readOnly?: boolean
  encoding?: string
  pendingPosition?: { line: number; column: number }
  isDiff?: boolean
  diffOriginal?: {
    envId: string
    path: string
    name: string
    content: string
  }
}

export interface ToastMessage {
  id: string
  kind: 'info' | 'success' | 'error'
  text: string
}

export interface EditorCursorInfo {
  line: number
  column: number
  language: string
  tabSize: number
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function clampFontSize(size: number): number {
  return Math.max(11, Math.min(24, Math.round(size)))
}

export function detectLanguageFromFilename(filePath: string): string {
  const base = filePath.split('/').pop()?.toLowerCase() ?? ''
  if (base === 'dockerfile') return 'dockerfile'
  if (base === 'makefile' || base === 'cmakelists.txt') return 'makefile'
  if (base === 'build' || base === 'build.bazel' || base === 'workspace' || base === 'buck') return 'python'
  const ext = base.includes('.') ? base.split('.').pop() ?? '' : ''
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    jsonc: 'json',
    py: 'python',
    pyi: 'python',
    pyx: 'python',
    pxd: 'python',
    bzl: 'python',
    sky: 'python',
    go: 'go',
    rs: 'rust',
    c: 'cpp',
    h: 'cpp',
    hh: 'cpp',
    cc: 'cpp',
    cpp: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    hxx: 'cpp',
    ipp: 'cpp',
    inl: 'cpp',
    tpp: 'cpp',
    cu: 'cpp',
    cuh: 'cpp',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    rb: 'ruby',
    php: 'php',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    fish: 'shell',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'ini',
    ini: 'ini',
    conf: 'ini',
    cfg: 'ini',
    md: 'markdown',
    mdx: 'markdown',
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    xml: 'xml',
    svg: 'xml',
    sql: 'sql',
    graphql: 'graphql',
    proto: 'protobuf',
    lua: 'lua',
    r: 'r',
    tf: 'hcl'
  }
  return map[ext] || 'plaintext'
}

function insertSplitLeaf(
  node: TerminalSplitNode,
  targetPaneId: string,
  direction: 'horizontal' | 'vertical',
  newLeaf: Extract<TerminalSplitNode, { type: 'leaf' }>
): TerminalSplitNode {
  if (node.type === 'leaf') {
    if (node.paneId !== targetPaneId) return node
    return {
      type: 'split',
      id: makeId('split'),
      direction,
      children: [node, newLeaf]
    }
  }
  const idx = node.children.findIndex((c) => c.type === 'leaf' && c.paneId === targetPaneId)
  if (idx >= 0 && node.direction === direction) {
    const nextChildren = [...node.children]
    nextChildren.splice(idx + 1, 0, newLeaf)
    return { ...node, children: nextChildren }
  }
  return {
    ...node,
    children: node.children.map((c) => insertSplitLeaf(c, targetPaneId, direction, newLeaf))
  }
}

function removeSplitLeaf(node: TerminalSplitNode, targetTerminalId: string): TerminalSplitNode | null {
  if (node.type === 'leaf') {
    return node.terminalId === targetTerminalId ? null : node
  }
  const nextChildren: TerminalSplitNode[] = []
  for (const child of node.children) {
    const res = removeSplitLeaf(child, targetTerminalId)
    if (res) nextChildren.push(res)
  }
  if (nextChildren.length === 0) return null
  if (nextChildren.length === 1) return nextChildren[0]
  return { ...node, children: nextChildren }
}

export function collectTerminalIds(node: TerminalSplitNode | undefined | null): string[] {
  if (!node) return []
  if (node.type === 'leaf') return [node.terminalId]
  return node.children.flatMap((c) => collectTerminalIds(c))
}

export function collectEnvTerminalIds(tabs: TerminalTab[] | undefined): string[] {
  if (!tabs || tabs.length === 0) return []
  return tabs.flatMap((t) => collectTerminalIds(t.root))
}

function findFirstLeaf(node: TerminalSplitNode | undefined | null): Extract<TerminalSplitNode, { type: 'leaf' }> | null {
  if (!node) return null
  if (node.type === 'leaf') return node
  for (const c of node.children) {
    const found = findFirstLeaf(c)
    if (found) return found
  }
  return null
}

function findLeafByPaneId(
  node: TerminalSplitNode | undefined | null,
  paneId?: string
): Extract<TerminalSplitNode, { type: 'leaf' }> | null {
  if (!node || !paneId) return null
  if (node.type === 'leaf') return node.paneId === paneId ? node : null
  for (const c of node.children) {
    const found = findLeafByPaneId(c, paneId)
    if (found) return found
  }
  return null
}

interface AppState {
  theme: EditorThemeId
  editorFontSize: number
  terminalFontSize: number
  configPath: string
  layoutMode: LayoutMode
  showSidebar: boolean
  showTerminalPanel: boolean
  showSearchPanel: boolean
  showTransferDrawer: boolean
  showQuickOpen: boolean
  showAddHostModal: boolean
  dualExplorerEnabled: boolean
  secondaryEnvId: string
  editorColumns: 1 | 2
  editorFocusGroup: 0 | 1

  environments: Environment[]
  activeEnvId: string
  envRootPaths: Record<string, string>
  envGitBranches: Record<string, string | null>
  envGitStatus: Record<string, Record<string, string>>
  envNotifications: Record<string, TerminalNotification[]>

  // Multi-Tab Terminals per environment (each Tab also supports recursive split panes!)
  terminalTabsByEnv: Record<string, TerminalTab[]>
  activeTerminalTabByEnv: Record<string, string | undefined>
  terminalStatuses: Record<string, TerminalStatusEvent | undefined>
  restoredTmuxEnvs: Record<string, boolean>
  focusedTerminalId: string | null
  activeFocusArea: 'editor' | 'terminal'

  tabs: EditorTab[]
  activeTabId: string | null
  secondaryTabId: string | null
  cursorInfo: EditorCursorInfo

  searchId: string | null
  searchQuery: string
  searchRunning: boolean
  searchMatches: SearchMatch[]
  searchDone: SearchDoneEvent | null
  searchEnvIds: string[]

  transfers: TransferTask[]
  dirRefreshNonce: Record<string, number>
  toasts: ToastMessage[]

  setTheme: (theme: EditorThemeId, persist?: boolean) => void
  setFontSizes: (sizes: { editorFontSize?: number; terminalFontSize?: number }, persist?: boolean) => void
  adjustFontSize: (delta: number) => void
  resetFontSizes: () => void
  setConfigPath: (path: string) => void
  openConfigFile: () => Promise<void>
  setLayoutMode: (mode: LayoutMode) => void
  toggleSidebar: () => void
  toggleTerminalPanel: () => void
  setShowSearchPanel: (v: boolean) => void
  setShowTransferDrawer: (v: boolean) => void
  setShowQuickOpen: (v: boolean) => void
  setShowAddHostModal: (v: boolean) => void
  setDualExplorerEnabled: (v: boolean) => void
  setSecondaryEnvId: (envId: string) => void
  setEditorColumns: (cols: 1 | 2) => void
  setEditorFocusGroup: (group: 0 | 1) => void
  setActiveFocusArea: (area: 'editor' | 'terminal') => void
  setCursorInfo: (info: Partial<EditorCursorInfo>) => void

  setEnvironments: (envs: Environment[], syncDefaults?: boolean) => void
  upsertEnvironment: (env: Environment) => void
  setActiveEnv: (envId: string) => void
  setEnvRootPath: (envId: string, rootPath: string) => void
  setEnvGitBranch: (envId: string, branch: string | null) => void
  setEnvGitStatus: (envId: string, statusMap: Record<string, string>) => void
  pushNotification: (n: TerminalNotification) => void
  clearEnvNotifications: (envId: string) => void

  ensureTerminalForEnv: (envId: string, cwd?: string) => Promise<string | null>
  restoreAdditionalTmuxTabs: (envId: string) => Promise<void>
  createTerminalTab: (
    envId: string,
    opts?: { cwd?: string; title?: string; tmuxSession?: string; attachRecentTmux?: boolean; focusTab?: boolean }
  ) => Promise<string | null>
  setActiveTerminalTab: (envId: string, tabId: string) => void
  cycleTerminalTab: (envId: string, delta: 1 | -1) => void
  renameTerminalTab: (envId: string, tabId: string, title: string) => void
  closeTerminalTab: (envId: string, tabId: string) => Promise<void>
  splitTerminal: (envId: string, direction: 'horizontal' | 'vertical', cwd?: string) => Promise<void>
  closeTerminal: (envId: string, terminalId: string) => Promise<void>
  reconnectTerminal: (terminalId: string, forceReset?: boolean) => Promise<void>
  pauseTerminalReconnect: (terminalId: string) => Promise<void>
  reconnectAllTerminals: (force?: boolean) => Promise<void>
  switchTerminalTmuxSession: (envId: string, terminalId: string, targetSession?: string) => Promise<void>
  listRemoteTmuxSessions: (envId: string) => Promise<RecoverableTmuxSession[]>
  killRemoteTmuxSession: (envId: string, sessionName: string) => Promise<boolean>
  pruneStaleTmuxSessions: (envId: string, minAgeSec?: number) => Promise<number>
  setTerminalStatus: (status: TerminalStatusEvent) => void
  handleTerminalExited: (terminalId: string, envId: string) => void
  setFocusedPane: (envId: string, tabId: string, paneId: string, terminalId: string) => void

  openFile: (envId: string, filePath: string, pos?: { line: number; column: number }, group?: 0 | 1) => Promise<void>
  retryLoadTab: (tabId: string) => Promise<void>
  retargetTabsForPath: (envId: string, oldPath: string, newPath: string) => void
  openDiffTab: (origTabId: string, modTabId: string) => void
  setActiveTab: (tabId: string, group?: 0 | 1) => void
  cycleEditorTab: (delta: 1 | -1) => void
  updateTabContent: (tabId: string, content: string) => void
  clearPendingPosition: (tabId: string) => void
  saveTab: (tabId: string) => Promise<boolean>
  closeTab: (tabId: string, force?: boolean) => void

  setSearchQuery: (q: string) => void
  setSearchEnvIds: (ids: string[]) => void
  startGlobalSearch: (opts: {
    query: string
    customPath?: string
    isRegex: boolean
    isCaseSensitive: boolean
    wholeWord: boolean
    includeGlob: string
    excludeGlob: string
  }) => Promise<void>
  cancelGlobalSearch: () => void
  appendSearchMatches: (matches: SearchMatch[]) => void
  finishGlobalSearch: (done: SearchDoneEvent) => void

  setTransfers: (tasks: TransferTask[]) => void
  upsertTransfer: (task: TransferTask) => void
  bumpDirRefresh: (envId: string) => void
  addToast: (kind: ToastMessage['kind'], text: string) => void
  dismissToast: (id: string) => void
}

interface SavedTmuxTabSnapshot {
  tmuxSession: string
  title: string
  cwd?: string
  isActive?: boolean
  updatedAt: number
}

const SAVED_TMUX_STORAGE_KEY = 'multiplex-tmux-tabs-v1'
const IDLE_SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'csh', 'tcsh'])

function isIdleShell(command?: string): boolean {
  const base = (command || '').trim().replace(/^-/, '').split('/').pop()?.toLowerCase() || ''
  return !base || IDLE_SHELLS.has(base)
}

function readAllSavedTmuxTabs(): Record<string, SavedTmuxTabSnapshot[]> {
  try {
    const raw = localStorage.getItem(SAVED_TMUX_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function loadSavedTmuxTabs(envId: string): SavedTmuxTabSnapshot[] {
  const all = readAllSavedTmuxTabs()
  const list = Array.isArray(all[envId]) ? all[envId] : []
  const cutoff = Date.now() - 24 * 3600 * 1000
  return list.filter((item) => item && typeof item.tmuxSession === 'string' && item.updatedAt > cutoff)
}

function persistTmuxTabsForEnv(
  envId: string,
  tabs: TerminalTab[],
  activeTabId: string | undefined,
  statuses: Record<string, TerminalStatusEvent | undefined>,
  fallbackCwd?: string
): void {
  try {
    const snapshots: SavedTmuxTabSnapshot[] = []
    const seen = new Set<string>()
    for (const tab of tabs) {
      const termIds = collectTerminalIds(tab.root)
      for (const tid of termIds) {
        const tmuxSession = statuses[tid]?.tmuxSession
        if (!tmuxSession || seen.has(tmuxSession)) continue
        seen.add(tmuxSession)
        snapshots.push({
          tmuxSession,
          title: tab.title,
          cwd: fallbackCwd,
          isActive: tab.id === activeTabId,
          updatedAt: Date.now()
        })
      }
    }
    const all = readAllSavedTmuxTabs()
    if (snapshots.length > 0) {
      all[envId] = snapshots
    } else {
      delete all[envId]
    }
    localStorage.setItem(SAVED_TMUX_STORAGE_KEY, JSON.stringify(all))
  } catch {
    // ignore storage quota / serialization errors
  }
}

const storedEditorFont = Number(localStorage.getItem('multiplex-editor-font'))
const storedTermFont = Number(localStorage.getItem('multiplex-terminal-font'))
const restoringTmuxEnvsInFlight = new Set<string>()
const ensuringTerminalInFlight = new Map<string, Promise<string | null>>()
const savesInFlight = new Map<string, Promise<boolean>>()

export const useAppStore = create<AppState>((set, get) => ({
  theme: (localStorage.getItem('multiplex-theme') as EditorThemeId) || 'monokai',
  editorFontSize: Number.isFinite(storedEditorFont) && storedEditorFont >= 11 ? clampFontSize(storedEditorFont) : 15,
  terminalFontSize: Number.isFinite(storedTermFont) && storedTermFont >= 11 ? clampFontSize(storedTermFont) : 14,
  configPath: '',
  layoutMode: 'ide',
  showSidebar: true,
  showTerminalPanel: true,
  showSearchPanel: false,
  showTransferDrawer: false,
  showQuickOpen: false,
  showAddHostModal: false,
  dualExplorerEnabled: false,
  secondaryEnvId: 'local',
  editorColumns: 1,
  editorFocusGroup: 0,

  environments: [],
  activeEnvId: 'local',
  envRootPaths: {},
  envGitBranches: {},
  envGitStatus: {},
  envNotifications: {},

  terminalTabsByEnv: {},
  activeTerminalTabByEnv: {},
  terminalStatuses: {},
  restoredTmuxEnvs: {},
  focusedTerminalId: null,
  activeFocusArea: 'editor',

  tabs: [],
  activeTabId: null,
  secondaryTabId: null,
  cursorInfo: { line: 1, column: 1, language: 'plaintext', tabSize: 2 },

  searchId: null,
  searchQuery: '',
  searchRunning: false,
  searchMatches: [],
  searchDone: null,
  searchEnvIds: [],

  transfers: [],
  dirRefreshNonce: {},
  toasts: [],

  setTheme: (theme, persist = true) => {
    localStorage.setItem('multiplex-theme', theme)
    document.documentElement.setAttribute('data-theme', theme)
    set({ theme })
    if (persist) {
      const firstId = get().environments[0]?.id || 'local'
      void window.multiplex.updateEnvSettings(firstId, { theme })
    }
  },

  setFontSizes: (sizes, persist = true) => {
    const nextEd = sizes.editorFontSize !== undefined ? clampFontSize(sizes.editorFontSize) : get().editorFontSize
    const nextTerm =
      sizes.terminalFontSize !== undefined ? clampFontSize(sizes.terminalFontSize) : get().terminalFontSize
    localStorage.setItem('multiplex-editor-font', String(nextEd))
    localStorage.setItem('multiplex-terminal-font', String(nextTerm))
    set({ editorFontSize: nextEd, terminalFontSize: nextTerm })
    if (persist) {
      const firstId = get().environments[0]?.id || 'local'
      void window.multiplex.updateEnvSettings(firstId, {
        editorFontSize: nextEd,
        terminalFontSize: nextTerm
      })
    }
  },

  adjustFontSize: (delta) => {
    const s = get()
    s.setFontSizes({
      editorFontSize: s.editorFontSize + delta,
      terminalFontSize: s.terminalFontSize + delta
    })
  },

  resetFontSizes: () => {
    get().setFontSizes({ editorFontSize: 15, terminalFontSize: 14 })
  },

  setConfigPath: (configPath) => set({ configPath }),

  openConfigFile: async () => {
    let cfgPath = get().configPath
    if (!cfgPath) {
      const info = await window.multiplex.getConfigInfo()
      cfgPath = info.configPath
      set({ configPath: cfgPath })
    }
    if (cfgPath) {
      await get().openFile('local', cfgPath)
    }
  },

  setLayoutMode: (layoutMode) => {
    set((s) => {
      let secondaryEnvId = s.secondaryEnvId
      if (layoutMode === 'transfer' && secondaryEnvId === s.activeEnvId) {
        const other = s.environments.find((e) => e.id !== s.activeEnvId)
        if (other) secondaryEnvId = other.id
      }
      return {
        layoutMode,
        showTerminalPanel: layoutMode === 'terminal' ? true : s.showTerminalPanel,
        dualExplorerEnabled: layoutMode === 'transfer' ? true : s.dualExplorerEnabled,
        secondaryEnvId
      }
    })
  },

  toggleSidebar: () => set((s) => ({ showSidebar: !s.showSidebar })),
  toggleTerminalPanel: () => set((s) => ({ showTerminalPanel: !s.showTerminalPanel })),
  setShowSearchPanel: (showSearchPanel) => set({ showSearchPanel }),
  setShowTransferDrawer: (showTransferDrawer) => set({ showTransferDrawer }),
  setShowQuickOpen: (showQuickOpen) => set({ showQuickOpen }),
  setShowAddHostModal: (showAddHostModal) => set({ showAddHostModal }),
  setDualExplorerEnabled: (dualExplorerEnabled) =>
    set((s) => {
      let secondaryEnvId = s.secondaryEnvId
      if (dualExplorerEnabled && (!s.environments.some((e) => e.id === secondaryEnvId) || secondaryEnvId === s.activeEnvId)) {
        const other = s.environments.find((e) => e.id !== s.activeEnvId)
        if (other) secondaryEnvId = other.id
      }
      return { dualExplorerEnabled, secondaryEnvId }
    }),
  setSecondaryEnvId: (secondaryEnvId) => set({ secondaryEnvId }),
  setEditorColumns: (editorColumns) =>
    set((s) => ({
      editorColumns,
      secondaryTabId: editorColumns === 2 ? s.secondaryTabId || s.activeTabId : s.secondaryTabId
    })),
  setEditorFocusGroup: (editorFocusGroup) => set({ editorFocusGroup }),
  setActiveFocusArea: (activeFocusArea) => set({ activeFocusArea }),
  setCursorInfo: (info) => set((s) => ({ cursorInfo: { ...s.cursorInfo, ...info } })),

  setEnvironments: (environments, syncDefaults = false) =>
    set((s) => {
      const nextRoots = { ...s.envRootPaths }
      const prevById = new Map(s.environments.map((e) => [e.id, e]))
      for (const e of environments) {
        const prevDefault = prevById.get(e.id)?.defaultPath
        // On config hot-reload only move an explorer whose configured defaultPath actually changed,
        // instead of yanking every explorer back to its default folder on any config save.
        if (!nextRoots[e.id] || (syncDefaults && prevDefault !== undefined && prevDefault !== e.defaultPath)) {
          nextRoots[e.id] = e.defaultPath
        }
      }
      const stillExists = environments.some((e) => e.id === s.activeEnvId)
      const secondExists = environments.some((e) => e.id === s.secondaryEnvId)
      const fallbackSecond = environments.find((e) => e.id !== s.activeEnvId)?.id || environments[0]?.id || 'local'
      return {
        environments,
        envRootPaths: nextRoots,
        activeEnvId: stillExists ? s.activeEnvId : environments[0]?.id || 'local',
        secondaryEnvId: secondExists ? s.secondaryEnvId : fallbackSecond
      }
    }),

  upsertEnvironment: (env) =>
    set((s) => {
      const idx = s.environments.findIndex((e) => e.id === env.id)
      const environments =
        idx >= 0
          ? s.environments.map((e) => (e.id === env.id ? env : e))
          : [...s.environments, env]
      const nextRoots = { ...s.envRootPaths }
      if (!nextRoots[env.id]) {
        nextRoots[env.id] = env.defaultPath
      }
      return { environments, envRootPaths: nextRoots }
    }),

  setActiveEnv: (envId) => {
    set((s) => {
      const nextNotifs = { ...s.envNotifications }
      delete nextNotifs[envId]
      const tabs = s.terminalTabsByEnv[envId] || []
      const activeTabId = s.activeTerminalTabByEnv[envId] || tabs[0]?.id
      const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0]
      const leaf = findLeafByPaneId(activeTab?.root, activeTab?.focusedPaneId) || findFirstLeaf(activeTab?.root)
      return {
        activeEnvId: envId,
        envNotifications: nextNotifs,
        focusedTerminalId: leaf?.terminalId ?? s.focusedTerminalId
      }
    })
    const state = get()
    if ((state.terminalTabsByEnv[envId] || []).length === 0) {
      void state.ensureTerminalForEnv(envId)
    }
  },

  setEnvRootPath: (envId, rootPath) =>
    set((s) => ({
      envRootPaths: { ...s.envRootPaths, [envId]: rootPath }
    })),

  setEnvGitBranch: (envId, branch) =>
    set((s) => ({
      envGitBranches: { ...s.envGitBranches, [envId]: branch }
    })),

  setEnvGitStatus: (envId, statusMap) =>
    set((s) => ({
      envGitStatus: { ...s.envGitStatus, [envId]: statusMap }
    })),

  pushNotification: (n) =>
    set((s) => {
      const tabs = s.terminalTabsByEnv[n.envId] || []
      const activeTabId = s.activeTerminalTabByEnv[n.envId]
      const updatedTabs = tabs.map((t) => {
        const ids = collectTerminalIds(t.root)
        if (ids.includes(n.terminalId) && (n.envId !== s.activeEnvId || t.id !== activeTabId || !s.showTerminalPanel)) {
          return { ...t, hasUnread: true }
        }
        return t
      })

      if (n.envId === s.activeEnvId && s.showTerminalPanel) {
        return {
          terminalTabsByEnv: { ...s.terminalTabsByEnv, [n.envId]: updatedTabs }
        }
      }
      const existing = s.envNotifications[n.envId] || []
      return {
        terminalTabsByEnv: { ...s.terminalTabsByEnv, [n.envId]: updatedTabs },
        envNotifications: {
          ...s.envNotifications,
          [n.envId]: [...existing.slice(-9), n]
        }
      }
    }),

  clearEnvNotifications: (envId) =>
    set((s) => {
      const next = { ...s.envNotifications }
      delete next[envId]
      return { envNotifications: next }
    }),

  ensureTerminalForEnv: async (envId, cwd) => {
    const existing = get().terminalTabsByEnv[envId] || []
    if (existing.length > 0) {
      const activeId = get().activeTerminalTabByEnv[envId] || existing[0].id
      const tab = existing.find((t) => t.id === activeId) || existing[0]
      const first = findFirstLeaf(tab.root)
      return first?.terminalId ?? null
    }

    const inFlight = ensuringTerminalInFlight.get(envId)
    if (inFlight) return inFlight

    const task = (async (): Promise<string | null> => {
      const env = get().environments.find((e) => e.id === envId)
      if (!env) return null

      if (env.kind === 'ssh' && env.useTmux && !get().restoredTmuxEnvs[envId]) {
        // Step 1: Establish ControlMaster cleanly ONCE before spawning any terminal PTY!
        // This completely eliminates the dual-SSH socket race and 1500ms attach-discovery race.
        let isConnected = env.status === 'connected'
        if (!isConnected) {
          const res = await window.multiplex.connectEnvironment(envId).catch((err) => ({
            ok: false,
            needsInteractiveAuth: false,
            error: String(err?.message || err)
          }))
          if (res.ok) {
            isConnected = true
          } else if (res.needsInteractiveAuth) {
            get().addToast('info', `${env.name}: complete login in terminal to enable SFTP & Search`)
            const saved = loadSavedTmuxTabs(envId)
            const preferred = saved.find((t) => t.isActive) || saved[0]
            return get().createTerminalTab(envId, {
              cwd,
              title: preferred?.title,
              tmuxSession: preferred?.tmuxSession,
              attachRecentTmux: !preferred
            })
          } else if (res.error) {
            get().addToast('error', `${env.name}: ${res.error}`)
            return get().createTerminalTab(envId, { cwd, attachRecentTmux: true })
          }
        }

        // Step 2: Connected! Inspect live remote tmux sessions and restore exact saved tabs first,
        // then any active (<1h) unattached `mide_*` sessions (prioritizing active processes like `agy`!).
        if (isConnected && !restoringTmuxEnvsInFlight.has(envId)) {
          restoringTmuxEnvsInFlight.add(envId)
          try {
            const liveSessions = await window.multiplex.listTmuxSessions(envId).catch(() => [])
            set((s) => ({ restoredTmuxEnvs: { ...s.restoredTmuxEnvs, [envId]: true } }))

            const liveByName = new Map(liveSessions.map((s) => [s.name, s]))
            const saved = loadSavedTmuxTabs(envId)
            const toRestore: Array<{ session: RecoverableTmuxSession; title?: string; isActive?: boolean }> = []
            const picked = new Set<string>()

            // Stage A: Restore exact tabs from the user's previous IDE session if still alive
            // (allows reattaching ghost-attached sessions too because `attach-session -d` evicts stale clients!)
            for (const snap of saved) {
              const live = liveByName.get(snap.tmuxSession)
              if (!live || live.ownedByApp || picked.has(live.name)) continue
              if (live.ageSec <= 7200 || !isIdleShell(live.command)) {
                picked.add(live.name)
                toRestore.push({ session: live, title: snap.title, isActive: snap.isActive })
              }
            }

            // Stage B: If no saved tabs matched, recover active (<1h) unattached `mide_*` sessions
            // prioritizing non-shell processes (`agy`, `python`, `vim`) ahead of idle shells!
            if (toRestore.length === 0) {
              const recentManaged = liveSessions
                .filter((s) => s.isManaged && !s.ownedByApp && s.attached === 0 && s.ageSec <= 3600)
                .sort((a, b) => {
                  const aAct = !isIdleShell(a.command)
                  const bAct = !isIdleShell(b.command)
                  if (aAct !== bAct) return aAct ? -1 : 1
                  return a.ageSec - b.ageSec
                })
                .slice(0, 6)
              for (const live of recentManaged) {
                if (picked.has(live.name)) continue
                picked.add(live.name)
                toRestore.push({ session: live })
              }
            }

            if (toRestore.length > 0) {
              // Choose which restored tab should receive initial focus (saved active tab, or first active process)
              let focusIdx = toRestore.findIndex((r) => r.isActive)
              if (focusIdx < 0) {
                focusIdx = toRestore.findIndex((r) => !isIdleShell(r.session.command))
              }
              if (focusIdx < 0) focusIdx = 0

              let focusedTermId: string | null = null
              for (let i = 0; i < toRestore.length; i++) {
                const { session: sess, title: savedTitle } = toRestore[i]
                const isCustomCmd = !isIdleShell(sess.command)
                const tabTitle = savedTitle || (isCustomCmd ? `${env.name} · ${sess.command}` : `${env.name} #${i + 1}`)
                const tid = await get().createTerminalTab(envId, {
                  cwd: sess.cwd || cwd,
                  title: tabTitle,
                  tmuxSession: sess.name,
                  focusTab: i === focusIdx
                })
                if (i === focusIdx) focusedTermId = tid
              }
              get().addToast('info', `Restored ${toRestore.length} active tmux session(s) on ${env.name}`)
              return focusedTermId
            }
          } finally {
            restoringTmuxEnvsInFlight.delete(envId)
          }
        }
      }

      // Guard in case tabs were created concurrently while awaiting connect
      const nowTabs = get().terminalTabsByEnv[envId] || []
      if (nowTabs.length > 0) {
        const first = findFirstLeaf(nowTabs[0].root)
        return first?.terminalId ?? null
      }

      return get().createTerminalTab(envId, { cwd })
    })()

    ensuringTerminalInFlight.set(envId, task)
    try {
      return await task
    } finally {
      if (ensuringTerminalInFlight.get(envId) === task) {
        ensuringTerminalInFlight.delete(envId)
      }
    }
  },

  restoreAdditionalTmuxTabs: async (envId) => {
    const s = get()
    if (s.restoredTmuxEnvs[envId] || restoringTmuxEnvsInFlight.has(envId) || ensuringTerminalInFlight.has(envId)) {
      return
    }
    const env = s.environments.find((e) => e.id === envId)
    if (!env || env.kind !== 'ssh' || !env.useTmux || env.status !== 'connected') return

    // Only restore for workspaces the user has opened (active or already has at least 1 tab)
    const existingTabs = s.terminalTabsByEnv[envId] || []
    if (existingTabs.length === 0 && s.activeEnvId !== envId) return

    restoringTmuxEnvsInFlight.add(envId)
    set((st) => ({ restoredTmuxEnvs: { ...st.restoredTmuxEnvs, [envId]: true } }))

    try {
      const recovered = await window.multiplex.listRecoverableTmuxSessions(envId, 3600).catch(() => [])
      if (recovered.length === 0) return

      const hadTabs = (get().terminalTabsByEnv[envId] || []).length > 0
      for (let i = 0; i < recovered.length; i++) {
        const sess = recovered[i]
        const isCustomCmd = !isIdleShell(sess.command)
        const baseNum = (get().terminalTabsByEnv[envId] || []).length + 1
        const tabTitle = isCustomCmd ? `${env.name} · ${sess.command}` : `${env.name} #${baseNum}`
        await get().createTerminalTab(envId, {
          cwd: sess.cwd,
          title: tabTitle,
          tmuxSession: sess.name,
          focusTab: !hadTabs && i === 0
        })
      }
      get().addToast(
        'info',
        `Restored ${recovered.length} ${hadTabs ? 'additional ' : ''}active tmux session(s) on ${env.name}`
      )
    } finally {
      restoringTmuxEnvsInFlight.delete(envId)
    }
  },

  createTerminalTab: async (envId, opts) => {
    const env = get().environments.find((e) => e.id === envId)
    if (!env) return null

    const existingTabs = get().terminalTabsByEnv[envId] || []
    const nextNum = existingTabs.length + 1
    const defaultTitle = opts?.title || `${env.kind === 'local' ? 'zsh' : env.name} #${nextNum}`
    const shouldFocus = opts?.focusTab !== false

    try {
      const info = await window.multiplex.createTerminal({
        envId,
        cwd: opts?.cwd || get().envRootPaths[envId] || env.defaultPath,
        title: defaultTitle,
        useTmux: env.useTmux,
        tmuxSession: opts?.tmuxSession,
        attachRecentTmux: opts?.attachRecentTmux,
        recentMaxAgeSec: 3600
      })
      const paneId = makeId('pane')
      const tabId = makeId('ttab')
      const leaf: Extract<TerminalSplitNode, { type: 'leaf' }> = {
        type: 'leaf',
        paneId,
        terminalId: info.id,
        title: defaultTitle
      }
      const newTab: TerminalTab = {
        id: tabId,
        envId,
        title: defaultTitle,
        root: leaf,
        focusedPaneId: paneId
      }

      set((s) => {
        const hasActiveTab = Boolean(s.activeTerminalTabByEnv[envId])
        const activateThis = shouldFocus || !hasActiveTab
        const nextEnvTabs = [...(s.terminalTabsByEnv[envId] || []), newTab]
        const nextActiveTabId = activateThis ? tabId : s.activeTerminalTabByEnv[envId]
        const nextStatuses = info.tmuxSession
          ? {
              ...s.terminalStatuses,
              [info.id]: {
                ...(s.terminalStatuses[info.id] || {
                  terminalId: info.id,
                  envId,
                  state: env.kind === 'local' ? 'connected' : 'connecting'
                }),
                tmuxSession: info.tmuxSession
              }
            }
          : s.terminalStatuses
        if (env.kind === 'ssh' && env.useTmux) {
          persistTmuxTabsForEnv(envId, nextEnvTabs, nextActiveTabId, nextStatuses, s.envRootPaths[envId] || env.defaultPath)
        }
        return {
          showTerminalPanel: true,
          terminalTabsByEnv: {
            ...s.terminalTabsByEnv,
            [envId]: nextEnvTabs
          },
          activeTerminalTabByEnv: {
            ...s.activeTerminalTabByEnv,
            [envId]: nextActiveTabId
          },
          terminalStatuses: nextStatuses,
          focusedTerminalId: activateThis && s.activeEnvId === envId ? info.id : s.focusedTerminalId,
          activeFocusArea: activateThis && s.activeEnvId === envId ? 'terminal' : s.activeFocusArea
        }
      })
      return info.id
    } catch (err: any) {
      get().addToast('error', `Failed to open terminal tab: ${err?.message || err}`)
      return null
    }
  },

  setActiveTerminalTab: (envId, tabId) =>
    set((s) => {
      const tabs = (s.terminalTabsByEnv[envId] || []).map((t) =>
        t.id === tabId ? { ...t, hasUnread: false } : t
      )
      const target = tabs.find((t) => t.id === tabId)
      const leaf = findLeafByPaneId(target?.root, target?.focusedPaneId) || findFirstLeaf(target?.root)
      const env = s.environments.find((e) => e.id === envId)
      if (env?.kind === 'ssh' && env.useTmux) {
        persistTmuxTabsForEnv(envId, tabs, tabId, s.terminalStatuses, s.envRootPaths[envId] || env.defaultPath)
      }
      return {
        terminalTabsByEnv: { ...s.terminalTabsByEnv, [envId]: tabs },
        activeTerminalTabByEnv: { ...s.activeTerminalTabByEnv, [envId]: tabId },
        focusedTerminalId: leaf?.terminalId ?? s.focusedTerminalId,
        activeFocusArea: 'terminal'
      }
    }),

  cycleTerminalTab: (envId, delta) => {
    const s = get()
    const tabs = s.terminalTabsByEnv[envId] || []
    if (tabs.length <= 1) return
    const curId = s.activeTerminalTabByEnv[envId] || tabs[0].id
    const idx = Math.max(0, tabs.findIndex((t) => t.id === curId))
    const nextIdx = (idx + delta + tabs.length) % tabs.length
    s.setActiveTerminalTab(envId, tabs[nextIdx].id)
  },

  renameTerminalTab: (envId, tabId, title) =>
    set((s) => {
      const trimmed = title.trim()
      if (!trimmed) return s
      const tabs = (s.terminalTabsByEnv[envId] || []).map((t) =>
        t.id === tabId ? { ...t, title: trimmed } : t
      )
      const env = s.environments.find((e) => e.id === envId)
      if (env?.kind === 'ssh' && env.useTmux) {
        persistTmuxTabsForEnv(
          envId,
          tabs,
          s.activeTerminalTabByEnv[envId],
          s.terminalStatuses,
          s.envRootPaths[envId] || env.defaultPath
        )
      }
      return {
        terminalTabsByEnv: { ...s.terminalTabsByEnv, [envId]: tabs }
      }
    }),

  closeTerminalTab: async (envId, tabId) => {
    const tabs = get().terminalTabsByEnv[envId] || []
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return
    const termIds = collectTerminalIds(tab.root)
    await Promise.all(termIds.map((id) => window.multiplex.killTerminal(id)))

    set((s) => {
      const curTabs = s.terminalTabsByEnv[envId] || []
      const idx = curTabs.findIndex((t) => t.id === tabId)
      const nextTabs = curTabs.filter((t) => t.id !== tabId)
      const nextActive =
        s.activeTerminalTabByEnv[envId] === tabId
          ? nextTabs[Math.min(idx, nextTabs.length - 1)]?.id
          : s.activeTerminalTabByEnv[envId]
      const nextActiveTab = nextTabs.find((t) => t.id === nextActive)
      const nextLeaf = findFirstLeaf(nextActiveTab?.root)
      const nextStatuses = { ...s.terminalStatuses }
      for (const id of termIds) delete nextStatuses[id]
      const env = s.environments.find((e) => e.id === envId)
      if (env?.kind === 'ssh' && env.useTmux) {
        persistTmuxTabsForEnv(envId, nextTabs, nextActive, nextStatuses, s.envRootPaths[envId] || env.defaultPath)
      }
      return {
        terminalTabsByEnv: { ...s.terminalTabsByEnv, [envId]: nextTabs },
        activeTerminalTabByEnv: { ...s.activeTerminalTabByEnv, [envId]: nextActive },
        terminalStatuses: nextStatuses,
        focusedTerminalId:
          s.focusedTerminalId && termIds.includes(s.focusedTerminalId)
            ? nextLeaf?.terminalId ?? null
            : s.focusedTerminalId
      }
    })
  },

  splitTerminal: async (envId, direction, cwd) => {
    const s = get()
    const env = s.environments.find((e) => e.id === envId)
    if (!env) return

    const tabs = s.terminalTabsByEnv[envId] || []
    if (tabs.length === 0) {
      await get().createTerminalTab(envId, { cwd })
      return
    }

    const activeTabId = s.activeTerminalTabByEnv[envId] || tabs[0].id
    const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0]

    try {
      const info = await window.multiplex.createTerminal({
        envId,
        cwd: cwd || s.envRootPaths[envId] || env.defaultPath,
        useTmux: env.useTmux
      })
      const paneId = makeId('pane')
      const newLeaf: Extract<TerminalSplitNode, { type: 'leaf' }> = {
        type: 'leaf',
        paneId,
        terminalId: info.id,
        title: info.title
      }
      const targetPaneId = activeTab.focusedPaneId || findFirstLeaf(activeTab.root)?.paneId || ''
      const updatedRoot = insertSplitLeaf(activeTab.root, targetPaneId, direction, newLeaf)

      set((st) => {
        const nextEnvTabs = (st.terminalTabsByEnv[envId] || []).map((t) =>
          t.id === activeTab.id ? { ...t, root: updatedRoot, focusedPaneId: paneId } : t
        )
        const nextStatuses = info.tmuxSession
          ? {
              ...st.terminalStatuses,
              [info.id]: {
                ...(st.terminalStatuses[info.id] || {
                  terminalId: info.id,
                  envId,
                  state: env.kind === 'local' ? 'connected' : 'connecting'
                }),
                tmuxSession: info.tmuxSession
              }
            }
          : st.terminalStatuses
        if (env.kind === 'ssh' && env.useTmux) {
          persistTmuxTabsForEnv(
            envId,
            nextEnvTabs,
            st.activeTerminalTabByEnv[envId],
            nextStatuses,
            st.envRootPaths[envId] || env.defaultPath
          )
        }
        return {
          showTerminalPanel: true,
          terminalTabsByEnv: {
            ...st.terminalTabsByEnv,
            [envId]: nextEnvTabs
          },
          terminalStatuses: nextStatuses,
          focusedTerminalId: info.id,
          activeFocusArea: 'terminal'
        }
      })
    } catch (err: any) {
      get().addToast('error', `Split terminal failed: ${err?.message || err}`)
    }
  },

  closeTerminal: async (envId, terminalId) => {
    await window.multiplex.killTerminal(terminalId)
    get().handleTerminalExited(terminalId, envId)
  },

  reconnectTerminal: async (terminalId, forceReset = true) => {
    await window.multiplex.reconnectTerminal(terminalId, forceReset)
  },

  pauseTerminalReconnect: async (terminalId) => {
    await window.multiplex.pauseTerminalReconnect(terminalId)
  },

  reconnectAllTerminals: async (force = false) => {
    await window.multiplex.reconnectAllTerminals(force)
  },

  switchTerminalTmuxSession: async (envId, terminalId, targetSession) => {
    const next = await window.multiplex.switchTerminalTmuxSession(terminalId, targetSession)
    if (next) {
      get().addToast('info', `Switched pane to tmux session ${next}`)
    }
    const s = get()
    const env = s.environments.find((e) => e.id === envId)
    if (env?.kind === 'ssh' && env.useTmux) {
      persistTmuxTabsForEnv(
        envId,
        s.terminalTabsByEnv[envId] || [],
        s.activeTerminalTabByEnv[envId],
        s.terminalStatuses,
        s.envRootPaths[envId] || env.defaultPath
      )
    }
  },

  listRemoteTmuxSessions: async (envId) => {
    return window.multiplex.listTmuxSessions(envId)
  },

  killRemoteTmuxSession: async (envId, sessionName) => {
    const ok = await window.multiplex.killTmuxSession(envId, sessionName)
    if (ok) {
      get().addToast('info', `Killed tmux session ${sessionName}`)
    }
    return ok
  },

  pruneStaleTmuxSessions: async (envId, minAgeSec = 3600) => {
    const count = await window.multiplex.pruneStaleTmuxSessions(envId, minAgeSec)
    get().addToast('info', count > 0 ? `Cleaned ${count} stale tmux session(s)` : 'No stale tmux sessions to clean')
    return count
  },

  setTerminalStatus: (status) =>
    set((s) => {
      const prev = s.terminalStatuses[status.terminalId]
      const nextStatuses = { ...s.terminalStatuses, [status.terminalId]: status }
      if (status.tmuxSession && status.tmuxSession !== prev?.tmuxSession) {
        const env = s.environments.find((e) => e.id === status.envId)
        if (env?.kind === 'ssh' && env.useTmux) {
          persistTmuxTabsForEnv(
            status.envId,
            s.terminalTabsByEnv[status.envId] || [],
            s.activeTerminalTabByEnv[status.envId],
            nextStatuses,
            s.envRootPaths[status.envId] || env.defaultPath
          )
        }
      }
      return { terminalStatuses: nextStatuses }
    }),

  handleTerminalExited: (terminalId, envId) =>
    set((s) => {
      const tabs = s.terminalTabsByEnv[envId] || []
      if (tabs.length === 0) return s

      const nextTabs: TerminalTab[] = []
      let removedTabIdx = -1
      let removedTabId: string | null = null

      tabs.forEach((tab, idx) => {
        const nextRoot = removeSplitLeaf(tab.root, terminalId)
        if (!nextRoot) {
          removedTabIdx = idx
          removedTabId = tab.id
        } else if (nextRoot !== tab.root) {
          const nextLeaf = findLeafByPaneId(nextRoot, tab.focusedPaneId) || findFirstLeaf(nextRoot)
          nextTabs.push({ ...tab, root: nextRoot, focusedPaneId: nextLeaf?.paneId })
        } else {
          nextTabs.push(tab)
        }
      })

      let nextActiveTabId = s.activeTerminalTabByEnv[envId]
      if (removedTabId && nextActiveTabId === removedTabId) {
        nextActiveTabId = nextTabs[Math.min(removedTabIdx, nextTabs.length - 1)]?.id
      }

      const activeTab = nextTabs.find((t) => t.id === nextActiveTabId) || nextTabs[0]
      const nextLeaf = findLeafByPaneId(activeTab?.root, activeTab?.focusedPaneId) || findFirstLeaf(activeTab?.root)

      const nextStatuses = { ...s.terminalStatuses }
      delete nextStatuses[terminalId]

      const env = s.environments.find((e) => e.id === envId)
      if (env?.kind === 'ssh' && env.useTmux) {
        persistTmuxTabsForEnv(envId, nextTabs, nextActiveTabId, nextStatuses, s.envRootPaths[envId] || env.defaultPath)
      }

      return {
        terminalTabsByEnv: { ...s.terminalTabsByEnv, [envId]: nextTabs },
        activeTerminalTabByEnv: { ...s.activeTerminalTabByEnv, [envId]: nextActiveTabId },
        terminalStatuses: nextStatuses,
        focusedTerminalId: s.focusedTerminalId === terminalId ? nextLeaf?.terminalId ?? null : s.focusedTerminalId
      }
    }),

  setFocusedPane: (envId, tabId, paneId, terminalId) =>
    set((s) => ({
      terminalTabsByEnv: {
        ...s.terminalTabsByEnv,
        [envId]: (s.terminalTabsByEnv[envId] || []).map((t) =>
          t.id === tabId ? { ...t, focusedPaneId: paneId, hasUnread: false } : t
        )
      },
      activeTerminalTabByEnv: { ...s.activeTerminalTabByEnv, [envId]: tabId },
      focusedTerminalId: terminalId,
      activeFocusArea: 'terminal'
    })),

  openFile: async (envId, filePath, pos, group) => {
    const tabId = `${envId}::${filePath}`
    const targetGroup = group ?? get().editorFocusGroup
    const existing = get().tabs.find((t) => t.id === tabId)

    if (existing) {
      set((s) => ({
        layoutMode: s.layoutMode === 'terminal' ? 'ide' : s.layoutMode,
        tabs: pos ? s.tabs.map((t) => (t.id === tabId ? { ...t, pendingPosition: pos } : t)) : s.tabs,
        activeTabId: targetGroup === 0 ? tabId : s.activeTabId,
        secondaryTabId: targetGroup === 1 ? tabId : s.secondaryTabId
      }))
      // Re-opening a tab that previously failed to load retries the read instead of showing the stale error
      if (existing.error && !existing.loading) {
        await get().retryLoadTab(tabId)
      }
      return
    }

    const name = filePath.split('/').pop() || filePath
    const language = detectLanguageFromFilename(filePath)
    const placeholder: EditorTab = {
      id: tabId,
      envId,
      path: filePath,
      name,
      language,
      content: '',
      savedContent: '',
      isDirty: false,
      isBinary: false,
      loading: true,
      pendingPosition: pos
    }

    set((s) => ({
      layoutMode: s.layoutMode === 'terminal' ? 'ide' : s.layoutMode,
      tabs: [...s.tabs, placeholder],
      activeTabId: targetGroup === 0 ? tabId : s.activeTabId || tabId,
      secondaryTabId: targetGroup === 1 ? tabId : s.secondaryTabId
    }))

    try {
      const res = await window.multiplex.readFile(envId, filePath)
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                path: res.path,
                content: res.content,
                savedContent: res.content,
                isBinary: res.isBinary,
                readOnly: res.readOnly,
                encoding: res.encoding,
                loading: false,
                error: undefined
              }
            : t
        )
      }))
    } catch (err: any) {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId ? { ...t, loading: false, error: err?.message || String(err) } : t
        )
      }))
    }
  },

  retryLoadTab: async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab || tab.isDiff || tab.loading) return
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, loading: true, error: undefined } : t))
    }))
    try {
      const res = await window.multiplex.readFile(tab.envId, tab.path)
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                content: res.content,
                savedContent: res.content,
                isDirty: false,
                isBinary: res.isBinary,
                readOnly: res.readOnly,
                encoding: res.encoding,
                loading: false,
                error: undefined
              }
            : t
        )
      }))
    } catch (err: any) {
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, loading: false, error: err?.message || String(err) } : t))
      }))
    }
  },

  retargetTabsForPath: (envId, oldPath, newPath) =>
    set((s) => {
      const remap = (p: string): string | null => {
        if (p === oldPath) return newPath
        if (p.startsWith(oldPath + '/')) return newPath + p.slice(oldPath.length)
        return null
      }
      const idMap = new Map<string, string>()
      const tabs = s.tabs.map((t) => {
        if (t.envId !== envId || t.isDiff) return t
        const next = remap(t.path)
        if (!next) return t
        const nextId = `${envId}::${next}`
        idMap.set(t.id, nextId)
        return {
          ...t,
          id: nextId,
          path: next,
          name: next.split('/').pop() || next,
          language: detectLanguageFromFilename(next)
        }
      })
      if (idMap.size === 0) return s
      return {
        tabs,
        activeTabId: s.activeTabId ? idMap.get(s.activeTabId) ?? s.activeTabId : s.activeTabId,
        secondaryTabId: s.secondaryTabId ? idMap.get(s.secondaryTabId) ?? s.secondaryTabId : s.secondaryTabId
      }
    }),

  openDiffTab: (origTabId, modTabId) => {
    const orig = get().tabs.find((t) => t.id === origTabId)
    const mod = get().tabs.find((t) => t.id === modTabId)
    if (!orig || !mod) return

    const diffId = `diff::${orig.id}::${mod.id}`
    const existing = get().tabs.find((t) => t.id === diffId)
    if (existing) {
      set({ activeTabId: diffId, layoutMode: 'ide' })
      return
    }

    const diffTab: EditorTab = {
      id: diffId,
      envId: mod.envId,
      path: mod.path,
      name: `${orig.name} ↔ ${mod.name}`,
      language: mod.language,
      content: mod.content,
      savedContent: mod.savedContent,
      isDirty: false,
      isBinary: false,
      loading: false,
      isDiff: true,
      diffOriginal: {
        envId: orig.envId,
        path: orig.path,
        name: orig.name,
        content: orig.content
      }
    }

    set((s) => ({
      layoutMode: 'ide',
      tabs: [...s.tabs, diffTab],
      activeTabId: diffId
    }))
  },

  setActiveTab: (tabId, group) =>
    set((s) => {
      const targetGroup = group ?? s.editorFocusGroup
      return {
        layoutMode: s.layoutMode === 'terminal' ? 'ide' : s.layoutMode,
        activeTabId: targetGroup === 0 ? tabId : s.activeTabId,
        secondaryTabId: targetGroup === 1 ? tabId : s.secondaryTabId
      }
    }),

  cycleEditorTab: (delta) => {
    const s = get()
    if (s.tabs.length <= 1) return
    const curId = s.editorFocusGroup === 1 && s.editorColumns === 2 ? s.secondaryTabId : s.activeTabId
    const idx = Math.max(0, s.tabs.findIndex((t) => t.id === curId))
    const nextIdx = (idx + delta + s.tabs.length) % s.tabs.length
    s.setActiveTab(s.tabs[nextIdx].id)
  },

  updateTabContent: (tabId, content) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, content, isDirty: content !== t.savedContent } : t
      )
    })),

  clearPendingPosition: (tabId) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, pendingPosition: undefined } : t))
    })),

  saveTab: async (tabId) => {
    const initial = get().tabs.find((t) => t.id === tabId)
    // Never write a tab whose content never loaded (error) — that would truncate the real file to 0 bytes!
    if (!initial || initial.isBinary || initial.loading || initial.isDiff || initial.error) return false
    if (initial.readOnly) {
      get().addToast(
        'error',
        `${initial.name} is ${initial.encoding || 'non-UTF-8'} encoded — opened read-only to avoid corrupting it`
      )
      return false
    }

    // Serialize saves per tab so two overlapping SFTP write streams never interleave on the same file
    const prev = savesInFlight.get(tabId)
    if (prev) await prev.catch(() => false)

    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab || tab.isBinary || tab.loading || tab.isDiff || tab.error) return false
    const written = tab.content

    const task = (async () => {
      try {
        await window.multiplex.writeFile(tab.envId, tab.path, written)
        set((s) => ({
          tabs: s.tabs.map((t) =>
            // Only mark what was actually written as saved; keystrokes typed during the save stay dirty
            t.id === tabId ? { ...t, savedContent: written, isDirty: t.content !== written } : t
          )
        }))
        const isCfg = get().configPath && tab.path === get().configPath
        get().addToast('success', isCfg ? 'Saved config — Workspaces reloaded!' : `Saved ${tab.name}`)
        return true
      } catch (err: any) {
        get().addToast('error', `Save failed: ${err?.message || err}`)
        return false
      }
    })()
    savesInFlight.set(tabId, task)
    try {
      return await task
    } finally {
      if (savesInFlight.get(tabId) === task) savesInFlight.delete(tabId)
    }
  },

  closeTab: (tabId, force = false) => {
    const target = get().tabs.find((t) => t.id === tabId)
    if (!target) return
    if (target.isDirty && !force) {
      const discard = window.confirm(`"${target.name}" has unsaved changes. Close without saving?`)
      if (!discard) return
    }
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === tabId)
      if (idx < 0) return s
      const nextTabs = s.tabs.filter((t) => t.id !== tabId)
      const fallback = nextTabs[Math.min(idx, nextTabs.length - 1)]?.id ?? null
      return {
        tabs: nextTabs,
        activeTabId: s.activeTabId === tabId ? fallback : s.activeTabId,
        secondaryTabId: s.secondaryTabId === tabId ? fallback : s.secondaryTabId
      }
    })
  },

  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setSearchEnvIds: (searchEnvIds) => set({ searchEnvIds }),

  startGlobalSearch: async (opts) => {
    const s = get()
    if (!opts.query.trim()) return
    if (s.searchId) {
      await window.multiplex.cancelSearch(s.searchId)
    }

    const searchId = makeId('srch')
    const envIds = s.searchEnvIds.length > 0 ? s.searchEnvIds : [s.activeEnvId]
    const targets = envIds
      .map((envId) => {
        const env = s.environments.find((e) => e.id === envId)
        if (!env) return null
        const customForSingle = envIds.length === 1 && opts.customPath?.trim() ? opts.customPath.trim() : undefined
        return { envId, rootPath: customForSingle || s.envRootPaths[envId] || env.defaultPath }
      })
      .filter(Boolean) as Array<{ envId: string; rootPath: string }>

    set({
      searchId,
      searchQuery: opts.query,
      searchRunning: true,
      searchMatches: [],
      searchDone: null,
      showSearchPanel: true
    })

    await window.multiplex.startSearch({
      searchId,
      query: opts.query,
      targets,
      isRegex: opts.isRegex,
      isCaseSensitive: opts.isCaseSensitive,
      wholeWord: opts.wholeWord,
      includeGlob: opts.includeGlob || undefined,
      excludeGlob: opts.excludeGlob || undefined,
      maxResults: 1500
    })
  },

  cancelGlobalSearch: () => {
    const id = get().searchId
    if (id) void window.multiplex.cancelSearch(id)
    set({ searchRunning: false })
  },

  appendSearchMatches: (matches) =>
    set((s) => {
      if (!s.searchId) return s
      const filtered = matches.filter((m) => m.searchId === s.searchId)
      if (filtered.length === 0) return s
      return { searchMatches: [...s.searchMatches, ...filtered] }
    }),

  finishGlobalSearch: (done) =>
    set((s) => {
      if (done.searchId !== s.searchId) return s
      return { searchRunning: false, searchDone: done }
    }),

  setTransfers: (transfers) => set({ transfers }),

  upsertTransfer: (task) =>
    set((s) => {
      const idx = s.transfers.findIndex((t) => t.id === task.id)
      const transfers =
        idx >= 0 ? s.transfers.map((t) => (t.id === task.id ? task : t)) : [task, ...s.transfers]
      const nextNonce = { ...s.dirRefreshNonce }
      if (task.status === 'completed') {
        nextNonce[task.targetEnvId] = (nextNonce[task.targetEnvId] || 0) + 1
      }
      return { transfers, dirRefreshNonce: nextNonce }
    }),

  bumpDirRefresh: (envId) =>
    set((s) => ({
      dirRefreshNonce: { ...s.dirRefreshNonce, [envId]: (s.dirRefreshNonce[envId] || 0) + 1 }
    })),

  addToast: (kind, text) => {
    const id = makeId('toast')
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }))
    setTimeout(() => {
      get().dismissToast(id)
    }, 3600)
  },

  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))
