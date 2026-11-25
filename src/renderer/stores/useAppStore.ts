import { create } from 'zustand'
import type {
  EditorThemeId,
  Environment,
  LayoutMode,
  SearchDoneEvent,
  SearchMatch,
  TerminalNotification,
  TerminalStatusEvent,
  TransferTask
} from '@shared/types'

export type TerminalSplitNode =
  | { type: 'leaf'; paneId: string; terminalId: string; title: string }
  | { type: 'split'; id: string; direction: 'horizontal' | 'vertical'; children: TerminalSplitNode[] }

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

function findFirstLeaf(node: TerminalSplitNode | undefined | null): Extract<TerminalSplitNode, { type: 'leaf' }> | null {
  if (!node) return null
  if (node.type === 'leaf') return node
  for (const c of node.children) {
    const found = findFirstLeaf(c)
    if (found) return found
  }
  return null
}

interface AppState {
  theme: EditorThemeId
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

  terminalTrees: Record<string, TerminalSplitNode | undefined>
  terminalStatuses: Record<string, TerminalStatusEvent | undefined>
  focusedPaneByEnv: Record<string, string | undefined>
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
  splitTerminal: (envId: string, direction: 'horizontal' | 'vertical', cwd?: string) => Promise<void>
  closeTerminal: (envId: string, terminalId: string) => Promise<void>
  reconnectTerminal: (terminalId: string, forceReset?: boolean) => Promise<void>
  setTerminalStatus: (status: TerminalStatusEvent) => void
  handleTerminalExited: (terminalId: string, envId: string) => void
  setFocusedPane: (envId: string, paneId: string, terminalId: string) => void

  openFile: (envId: string, filePath: string, pos?: { line: number; column: number }, group?: 0 | 1) => Promise<void>
  openDiffTab: (origTabId: string, modTabId: string) => void
  setActiveTab: (tabId: string, group?: 0 | 1) => void
  updateTabContent: (tabId: string, content: string) => void
  clearPendingPosition: (tabId: string) => void
  saveTab: (tabId: string) => Promise<boolean>
  closeTab: (tabId: string) => void

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

export const useAppStore = create<AppState>((set, get) => ({
  theme: (localStorage.getItem('multiplex-theme') as EditorThemeId) || 'monokai',
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

  terminalTrees: {},
  terminalStatuses: {},
  focusedPaneByEnv: {},
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
      for (const e of environments) {
        if (!nextRoots[e.id] || syncDefaults) {
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
      const leaf = findFirstLeaf(s.terminalTrees[envId])
      return {
        activeEnvId: envId,
        envNotifications: nextNotifs,
        focusedTerminalId: leaf?.terminalId ?? s.focusedTerminalId
      }
    })
    const state = get()
    if (!state.terminalTrees[envId]) {
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
      if (n.envId === s.activeEnvId && s.showTerminalPanel) return s
      const existing = s.envNotifications[n.envId] || []
      return {
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
    const existingTree = get().terminalTrees[envId]
    if (existingTree) {
      const first = findFirstLeaf(existingTree)
      return first?.terminalId ?? null
    }
    const env = get().environments.find((e) => e.id === envId)
    if (!env) return null

    try {
      const info = await window.multiplex.createTerminal({
        envId,
        cwd: cwd || get().envRootPaths[envId] || env.defaultPath,
        useTmux: env.useTmux
      })
      const paneId = makeId('pane')
      const leaf: Extract<TerminalSplitNode, { type: 'leaf' }> = {
        type: 'leaf',
        paneId,
        terminalId: info.id,
        title: info.title
      }
      set((s) => ({
        terminalTrees: { ...s.terminalTrees, [envId]: leaf },
        focusedPaneByEnv: { ...s.focusedPaneByEnv, [envId]: paneId },
        focusedTerminalId: s.activeEnvId === envId ? info.id : s.focusedTerminalId
      }))
      return info.id
    } catch (err: any) {
      get().addToast('error', `Failed to open terminal: ${err?.message || err}`)
      return null
    }
  },

  splitTerminal: async (envId, direction, cwd) => {
    const s = get()
    const env = s.environments.find((e) => e.id === envId)
    if (!env) return

    const existingTree = s.terminalTrees[envId]
    if (!existingTree) {
      await get().ensureTerminalForEnv(envId, cwd)
      return
    }

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
      const targetPaneId = s.focusedPaneByEnv[envId] || findFirstLeaf(existingTree)?.paneId || ''
      const updated = insertSplitLeaf(existingTree, targetPaneId, direction, newLeaf)
      set((st) => ({
        showTerminalPanel: true,
        terminalTrees: { ...st.terminalTrees, [envId]: updated },
        focusedPaneByEnv: { ...st.focusedPaneByEnv, [envId]: paneId },
        focusedTerminalId: info.id
      }))
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

  setTerminalStatus: (status) =>
    set((s) => ({
      terminalStatuses: { ...s.terminalStatuses, [status.terminalId]: status }
    })),

  handleTerminalExited: (terminalId, envId) =>
    set((s) => {
      const tree = s.terminalTrees[envId]
      if (!tree) return s
      const nextTree = removeSplitLeaf(tree, terminalId)
      const nextLeaf = findFirstLeaf(nextTree)
      const nextStatuses = { ...s.terminalStatuses }
      delete nextStatuses[terminalId]
      return {
        terminalTrees: { ...s.terminalTrees, [envId]: nextTree ?? undefined },
        terminalStatuses: nextStatuses,
        focusedPaneByEnv: { ...s.focusedPaneByEnv, [envId]: nextLeaf?.paneId },
        focusedTerminalId: s.focusedTerminalId === terminalId ? nextLeaf?.terminalId ?? null : s.focusedTerminalId
      }
    }),

  setFocusedPane: (envId, paneId, terminalId) =>
    set((s) => ({
      focusedPaneByEnv: { ...s.focusedPaneByEnv, [envId]: paneId },
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
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab || tab.isBinary || tab.loading || tab.isDiff) return false
    try {
      await window.multiplex.writeFile(tab.envId, tab.path, tab.content)
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId ? { ...t, savedContent: t.content, isDirty: false } : t
        )
      }))
      const isCfg = get().configPath && tab.path === get().configPath
      get().addToast('success', isCfg ? 'Saved config.json — Workspaces reloaded!' : `Saved ${tab.name}`)
      return true
    } catch (err: any) {
      get().addToast('error', `Save failed: ${err?.message || err}`)
      return false
    }
  },

  closeTab: (tabId) =>
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
    }),

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
