import React, { useEffect } from 'react'
import { Allotment } from 'allotment'
import { useAppStore } from '@renderer/stores/useAppStore'
import { TopToolbar } from './components/Layout/TopToolbar'
import { StatusBar } from './components/Layout/StatusBar'
import { AddHostModal } from './components/Sidebar/AddHostModal'
import { FileTreePanel, SingleEnvFileTree } from './components/Explorer/FileTreePanel'
import { TransferQueueDrawer } from './components/Explorer/TransferQueueDrawer'
import { EditorWorkbench } from './components/Editor/EditorWorkbench'
import { QuickOpenModal } from './components/Editor/QuickOpenModal'
import { TerminalWorkspaceArea } from './components/Terminal/TerminalPaneTree'
import { GlobalSearchPanel } from './components/Search/GlobalSearchPanel'
import { handleClipboardAction } from './utils/clipboardBridge'

export default function App() {
  const theme = useAppStore((s) => s.theme)
  const layoutMode = useAppStore((s) => s.layoutMode)
  const showSidebar = useAppStore((s) => s.showSidebar)
  const showTerminalPanel = useAppStore((s) => s.showTerminalPanel)
  const showSearchPanel = useAppStore((s) => s.showSearchPanel)
  const activeEnvId = useAppStore((s) => s.activeEnvId)
  const secondaryEnvId = useAppStore((s) => s.secondaryEnvId)
  const environments = useAppStore((s) => s.environments)
  const envRootPaths = useAppStore((s) => s.envRootPaths)
  const toasts = useAppStore((s) => s.toasts)
  const dismissToast = useAppStore((s) => s.dismissToast)

  const setTheme = useAppStore((s) => s.setTheme)
  const setFontSizes = useAppStore((s) => s.setFontSizes)
  const setConfigPath = useAppStore((s) => s.setConfigPath)
  const setEnvironments = useAppStore((s) => s.setEnvironments)
  const upsertEnvironment = useAppStore((s) => s.upsertEnvironment)
  const ensureTerminalForEnv = useAppStore((s) => s.ensureTerminalForEnv)
  const handleTerminalExited = useAppStore((s) => s.handleTerminalExited)
  const setTerminalStatus = useAppStore((s) => s.setTerminalStatus)
  const pushNotification = useAppStore((s) => s.pushNotification)
  const upsertTransfer = useAppStore((s) => s.upsertTransfer)
  const setTransfers = useAppStore((s) => s.setTransfers)
  const appendSearchMatches = useAppStore((s) => s.appendSearchMatches)
  const finishGlobalSearch = useAppStore((s) => s.finishGlobalSearch)
  const setEnvGitBranch = useAppStore((s) => s.setEnvGitBranch)
  const setEnvGitStatus = useAppStore((s) => s.setEnvGitStatus)
  const setSecondaryEnvId = useAppStore((s) => s.setSecondaryEnvId)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  useEffect(() => {
    let mounted = true
    const init = async () => {
      const [cfgInfo, envs, xfers] = await Promise.all([
        window.multiplex.getConfigInfo(),
        window.multiplex.listEnvironments(),
        window.multiplex.listTransfers()
      ])
      if (!mounted) return
      setConfigPath(cfgInfo.configPath)
      if (cfgInfo.theme) {
        setTheme(cfgInfo.theme, false)
      }
      if (cfgInfo.editorFontSize || cfgInfo.terminalFontSize) {
        setFontSizes(
          {
            editorFontSize: cfgInfo.editorFontSize,
            terminalFontSize: cfgInfo.terminalFontSize
          },
          false
        )
      }
      setEnvironments(envs)
      setTransfers(xfers)
      const firstId = envs[0]?.id || 'local'
      await ensureTerminalForEnv(firstId)
    }
    void init()

    const unsubs = [
      window.multiplex.onConfigUpdated(
        ({ environments: nextEnvs, theme: nextTheme, editorFontSize, terminalFontSize }) => {
          setEnvironments(nextEnvs, true)
          if (nextTheme) setTheme(nextTheme, false)
          if (editorFontSize || terminalFontSize) {
            setFontSizes({ editorFontSize, terminalFontSize }, false)
          }
        }
      ),
      window.multiplex.onEnvStatusChanged((env) => {
        upsertEnvironment(env)
        if (env.kind === 'ssh' && env.status === 'connected' && env.useTmux) {
          void useAppStore.getState().restoreAdditionalTmuxTabs(env.id)
        }
      }),
      window.multiplex.onTerminalExit((terminalId, envId) => handleTerminalExited(terminalId, envId)),
      window.multiplex.onTerminalStatus((status) => {
        setTerminalStatus(status)
        if (status.message?.startsWith('Reattached active tmux session')) {
          useAppStore.getState().addToast('info', status.message)
        }
      }),
      window.multiplex.onTerminalNotification((n) => pushNotification(n)),
      window.multiplex.onTransferUpdate((task) => upsertTransfer(task)),
      window.multiplex.onSearchMatchBatch((batch) => appendSearchMatches(batch)),
      window.multiplex.onSearchDone((done) => finishGlobalSearch(done)),
      window.multiplex.onClipboardAction((action) => handleClipboardAction(action))
    ]

    // Automatically wake and re-attach SSH terminals when macOS network comes back online!
    const onNetworkOnline = () => {
      void useAppStore.getState().reconnectAllTerminals(false)
    }
    window.addEventListener('online', onNetworkOnline)

    return () => {
      mounted = false
      window.removeEventListener('online', onNetworkOnline)
      unsubs.forEach((fn) => fn())
    }
  }, [])

  // Refresh Git branch & status for active connected workspace
  useEffect(() => {
    const env = environments.find((e) => e.id === activeEnvId)
    if (!env || env.status !== 'connected') return
    const root = envRootPaths[env.id] || env.defaultPath

    let cancelled = false
    const refreshGit = async () => {
      const [branch, statuses] = await Promise.all([
        window.multiplex.getGitBranch(env.id, root).catch(() => null),
        window.multiplex.getGitStatus(env.id, root).catch(() => [])
      ])
      if (cancelled) return
      setEnvGitBranch(env.id, branch)
      const map: Record<string, string> = {}
      for (const st of statuses) map[st.path] = st.status
      setEnvGitStatus(env.id, map)
    }
    void refreshGit()
    const timer = setInterval(refreshGit, 12_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [activeEnvId, environments, envRootPaths])

  // Capture-phase global shortcuts so Monaco & xterm never swallow Cmd+P / Cmd+Shift+F / Cmd+1..9 / Cmd+,
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey) return
      const state = useAppStore.getState()

      // Cmd+1..9 -> Switch workspace
      if (!e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key, 10) - 1
        const target = state.environments[idx]
        if (target) {
          e.preventDefault()
          e.stopPropagation()
          state.setActiveEnv(target.id)
        }
        return
      }

      // Alt+Cmd+1 / Alt+Cmd+2 -> Sublime Column Layouts
      if (e.altKey && !e.shiftKey && (e.code === 'Digit1' || e.code === 'Digit2')) {
        e.preventDefault()
        e.stopPropagation()
        state.setEditorColumns(e.code === 'Digit2' ? 2 : 1)
        return
      }

      // Alt+Cmd+Left / Alt+Cmd+Right -> Switch Editor Tab (Sublime / macOS standard)
      if (e.altKey && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        if (state.tabs.length > 1) {
          e.preventDefault()
          e.stopPropagation()
          state.cycleEditorTab(e.key === 'ArrowLeft' ? -1 : 1)
        }
        return
      }

      const key = e.key.toLowerCase()

      // Cmd+, -> Open config.json in Editor (Sublime Preferences UX!)
      if (!e.shiftKey && !e.altKey && e.key === ',') {
        e.preventDefault()
        e.stopPropagation()
        void state.openConfigFile()
        return
      }

      // Cmd+P -> Sublime Goto Anything
      if (!e.shiftKey && !e.altKey && key === 'p') {
        e.preventDefault()
        e.stopPropagation()
        state.setShowQuickOpen(!state.showQuickOpen)
        return
      }

      // Cmd+Shift+F -> Sublime Find in Files
      if (e.shiftKey && !e.altKey && key === 'f') {
        e.preventDefault()
        e.stopPropagation()
        state.setShowSearchPanel(true)
        return
      }

      // Cmd+B -> Toggle Sidebar
      if (!e.shiftKey && !e.altKey && key === 'b') {
        e.preventDefault()
        e.stopPropagation()
        state.toggleSidebar()
        return
      }

      // Cmd+J -> Toggle Terminal Panel
      if (!e.shiftKey && !e.altKey && key === 'j') {
        e.preventDefault()
        e.stopPropagation()
        state.toggleTerminalPanel()
        return
      }

      // Cmd+\ and Cmd+Shift+\ -> Split Terminal (VS Code / cmux style)
      if (!e.altKey && e.code === 'Backslash') {
        e.preventDefault()
        e.stopPropagation()
        void state.splitTerminal(state.activeEnvId, e.shiftKey ? 'vertical' : 'horizontal')
        return
      }

      // iTerm2 Terminal Shortcuts (active only when terminal has focus so Monaco Cmd+D stays untouched!)
      const inTerminal = state.activeFocusArea === 'terminal' || state.layoutMode === 'terminal'

      // Cmd+D / Cmd+Shift+D -> Split Terminal Right / Down (classic iTerm2!)
      if (inTerminal && !e.altKey && key === 'd') {
        e.preventDefault()
        e.stopPropagation()
        void state.splitTerminal(state.activeEnvId, e.shiftKey ? 'vertical' : 'horizontal')
        return
      }

      // Cmd+[ / Cmd+] -> Cycle Focus Between Split Panes (classic iTerm2!)
      if (inTerminal && !e.shiftKey && !e.altKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        e.preventDefault()
        e.stopPropagation()
        state.cycleFocusedPane(state.activeEnvId, e.code === 'BracketLeft' ? -1 : 1)
        return
      }

      // Cmd+Shift+Enter -> Zoom / Restore Active Split Pane (classic iTerm2!)
      if (inTerminal && e.shiftKey && !e.altKey && e.key === 'Enter') {
        const tabs = state.terminalTabsByEnv[state.activeEnvId] || []
        const activeTabId = state.activeTerminalTabByEnv[state.activeEnvId] || tabs[0]?.id
        if (activeTabId) {
          e.preventDefault()
          e.stopPropagation()
          state.toggleZoomPane(activeTabId)
        }
        return
      }

      // Cmd+Shift+T (anywhere) or Cmd+T (in terminal) -> New Terminal Tab
      if (
        !e.altKey &&
        key === 't' &&
        (e.shiftKey || state.activeFocusArea === 'terminal' || state.layoutMode === 'terminal')
      ) {
        e.preventDefault()
        e.stopPropagation()
        void state.createTerminalTab(state.activeEnvId)
        return
      }

      // Cmd+Shift+[ / Cmd+Shift+] -> Switch Terminal Tab
      if (e.shiftKey && !e.altKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        e.preventDefault()
        e.stopPropagation()
        state.cycleTerminalTab(state.activeEnvId, e.code === 'BracketLeft' ? -1 : 1)
        return
      }

      // Cmd+= / Cmd++ / Cmd+- / Cmd+0 -> Crisp Editor & Terminal Font Size Adjustment
      if (!e.altKey && (e.code === 'Equal' || e.key === '+' || e.key === '=')) {
        e.preventDefault()
        e.stopPropagation()
        state.adjustFontSize(1)
        return
      }
      if (!e.altKey && (e.code === 'Minus' || e.key === '-')) {
        e.preventDefault()
        e.stopPropagation()
        state.adjustFontSize(-1)
        return
      }
      if (!e.altKey && !e.shiftKey && (e.code === 'Digit0' || e.key === '0')) {
        e.preventDefault()
        e.stopPropagation()
        state.resetFontSizes()
        return
      }

      // Cmd+W -> Close active terminal pane/tab OR active editor tab
      if (!e.shiftKey && !e.altKey && key === 'w') {
        if ((state.activeFocusArea === 'terminal' || state.layoutMode === 'terminal') && state.focusedTerminalId) {
          e.preventDefault()
          e.stopPropagation()
          void state.closeTerminal(state.activeEnvId, state.focusedTerminalId)
          return
        }
        const targetTabId =
          state.editorFocusGroup === 1 && state.editorColumns === 2 ? state.secondaryTabId : state.activeTabId
        if (state.activeFocusArea === 'editor' && targetTabId) {
          e.preventDefault()
          e.stopPropagation()
          state.closeTab(targetTabId)
          return
        }
      }

      // Cmd+S -> Save active editor tab
      if (!e.shiftKey && !e.altKey && key === 's') {
        const targetId =
          state.editorFocusGroup === 1 && state.editorColumns === 2 ? state.secondaryTabId : state.activeTabId
        if (targetId) {
          e.preventDefault()
          e.stopPropagation()
          void state.saveTab(targetId)
        }
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden">
      <TopToolbar />

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {layoutMode === 'terminal' ? (
          <TerminalWorkspaceArea />
        ) : layoutMode === 'transfer' ? (
          <Allotment vertical>
            <Allotment.Pane minSize={240}>
              <Allotment proportionalLayout>
                <Allotment.Pane minSize={260}>
                  <SingleEnvFileTree envId={activeEnvId} />
                </Allotment.Pane>
                <Allotment.Pane minSize={260}>
                  <SingleEnvFileTree
                    envId={secondaryEnvId}
                    headerSlot={
                      <div className="flex items-center gap-1.5">
                        <span className="st3-section-title">Target:</span>
                        <select
                          value={secondaryEnvId}
                          onChange={(e) => setSecondaryEnvId(e.target.value)}
                          className="rounded border px-1.5 py-0.5 text-[12px] font-mono outline-none"
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
                      </div>
                    }
                  />
                </Allotment.Pane>
              </Allotment>
            </Allotment.Pane>
            {showTerminalPanel && (
              <Allotment.Pane preferredSize="32%" minSize={140}>
                <TerminalWorkspaceArea />
              </Allotment.Pane>
            )}
          </Allotment>
        ) : (
          /* Unified Sublime Text 3 Layout: Single Clean Left Sidebar + Editor/Search/Terminal */
          <Allotment>
            {showSidebar && (
              <Allotment.Pane preferredSize={275} minSize={200} maxSize={520}>
                <FileTreePanel />
              </Allotment.Pane>
            )}

            <Allotment.Pane minSize={420}>
              <Allotment vertical>
                <Allotment.Pane minSize={180}>
                  <EditorWorkbench />
                </Allotment.Pane>

                {showSearchPanel && (
                  <Allotment.Pane preferredSize="30%" minSize={145}>
                    <GlobalSearchPanel />
                  </Allotment.Pane>
                )}

                {showTerminalPanel && (
                  <Allotment.Pane preferredSize="34%" minSize={120}>
                    <TerminalWorkspaceArea />
                  </Allotment.Pane>
                )}
              </Allotment>
            </Allotment.Pane>
          </Allotment>
        )}
      </div>

      <StatusBar />

      <QuickOpenModal />
      <AddHostModal />
      <TransferQueueDrawer />

      {toasts.length > 0 && (
        <div className="fixed bottom-9 left-1/2 z-50 -translate-x-1/2 flex flex-col gap-1.5 pointer-events-none">
          {toasts.map((t) => (
            <div
              key={t.id}
              onClick={() => dismissToast(t.id)}
              className="pointer-events-auto cursor-pointer rounded border px-3.5 py-1.5 text-[12.5px] shadow-xl"
              style={{
                backgroundColor: 'var(--st-panel)',
                borderColor:
                  t.kind === 'error'
                    ? 'var(--st-red)'
                    : t.kind === 'success'
                      ? 'var(--st-green)'
                      : 'var(--st-border-light)',
                color: 'var(--st-text)'
              }}
            >
              {t.text}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
