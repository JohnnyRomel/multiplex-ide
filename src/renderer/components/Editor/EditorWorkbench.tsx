import React, { useEffect, useMemo, useRef, useState } from 'react'
import * as monaco from 'monaco-editor'
import { Allotment } from 'allotment'
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  FileSearch,
  GitCompare,
  ListTree,
  Loader2,
  Save,
  Search,
  Settings,
  Terminal,
  X
} from 'lucide-react'
import { isHeaderPath, isSourcePath } from '@shared/symbolIntel'
import logoUrl from '@renderer/assets/logo.png'
import { FileIcon } from '@renderer/components/Common/FileIcon'
import { type EditorTab, useAppStore } from '@renderer/stores/useAppStore'
import { registerMonacoEditor, unregisterMonacoEditor } from '@renderer/utils/clipboardBridge'
import { bindSublimeKeybindings, getMonacoThemeName, initMonacoSublime } from './monacoSetup'
import { jumpToCodeLocation, switchCppHeaderSource, tabModelUri } from './codeIntel'

initMonacoSublime()

interface MonacoPaneProps {
  tab: EditorTab | null
  group: 0 | 1
}

const MonacoPane: React.FC<MonacoPaneProps> = ({ tab, group }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const activeTabRef = useRef<EditorTab | null>(tab)
  activeTabRef.current = tab

  // Dispose Monaco models of closed tabs (8 MB files would otherwise leak forever). Pane 0 owns this.
  const openTabKeys = useAppStore((s) =>
    s.tabs
      .filter((t) => !t.isDiff)
      .map((t) => tabModelUri(t.envId, t.path).toString())
      .join('\n')
  )
  useEffect(() => {
    if (group !== 0) return
    const timer = setTimeout(() => {
      const live = new Set(openTabKeys ? openTabKeys.split('\n') : [])
      const attached = new Set(monaco.editor.getEditors().map((e) => e.getModel()))
      for (const model of monaco.editor.getModels()) {
        if (model.uri.scheme !== 'multiplex') continue
        if (live.has(model.uri.toString()) || attached.has(model)) continue
        model.dispose()
      }
    }, 0)
    return () => clearTimeout(timer)
  }, [openTabKeys, group])

  const theme = useAppStore((s) => s.theme)
  const editorFontSize = useAppStore((s) => s.editorFontSize)
  const updateTabContent = useAppStore((s) => s.updateTabContent)
  const saveTab = useAppStore((s) => s.saveTab)
  const clearPendingPosition = useAppStore((s) => s.clearPendingPosition)
  const setCursorInfo = useAppStore((s) => s.setCursorInfo)
  const setEditorFocusGroup = useAppStore((s) => s.setEditorFocusGroup)
  const setActiveFocusArea = useAppStore((s) => s.setActiveFocusArea)
  const openFile = useAppStore((s) => s.openFile)

  const isDiff = Boolean(tab?.isDiff && tab?.diffOriginal)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const initialFontSize = useAppStore.getState().editorFontSize
    const initialLineHeight = Math.round(initialFontSize * 1.52)

    if (isDiff) {
      editorRef.current?.dispose()
      editorRef.current = null

      const diffEd = monaco.editor.createDiffEditor(el, {
        theme: getMonacoThemeName(useAppStore.getState().theme),
        automaticLayout: true,
        readOnly: true,
        renderSideBySide: true,
        fontFamily: 'ui-monospace, "SF Mono", Menlo, "JetBrains Mono", Monaco, monospace',
        fontSize: initialFontSize,
        lineHeight: initialLineHeight,
        minimap: { enabled: false }
      })
      diffEditorRef.current = diffEd
      const origEd = diffEd.getOriginalEditor()
      const modEd = diffEd.getModifiedEditor()
      registerMonacoEditor(`pane-${group}-orig`, origEd)
      registerMonacoEditor(`pane-${group}-mod`, modEd)
      const subOrigFocus = origEd.onDidFocusEditorText(() => {
        setEditorFocusGroup(group)
        setActiveFocusArea('editor')
      })
      const subModFocus = modEd.onDidFocusEditorText(() => {
        setEditorFocusGroup(group)
        setActiveFocusArea('editor')
      })
      return () => {
        subOrigFocus.dispose()
        subModFocus.dispose()
        unregisterMonacoEditor(`pane-${group}-orig`, origEd)
        unregisterMonacoEditor(`pane-${group}-mod`, modEd)
        diffEd.dispose()
        diffEditorRef.current = null
      }
    }

    diffEditorRef.current?.dispose()
    diffEditorRef.current = null

    const ed = monaco.editor.create(el, {
      theme: getMonacoThemeName(useAppStore.getState().theme),
      automaticLayout: true,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, "JetBrains Mono", Monaco, monospace',
      fontSize: initialFontSize,
      lineHeight: initialLineHeight,
      tabSize: 2,
      insertSpaces: true,
      smoothScrolling: true,
      cursorBlinking: 'phase',
      renderLineHighlight: 'line',
      // `alt` lets `⌘+Click` trigger C++/symbol Go-to-Definition (VS Code macOS standard),
      // while `⌥+Click` adds multi-cursors!
      multiCursorModifier: 'alt',
      hover: {
        enabled: true,
        delay: 220,
        sticky: true
      },
      occurrencesHighlight: 'singleFile',
      scrollBeyondLastLine: true,
      minimap: {
        enabled: true,
        renderCharacters: false,
        showSlider: 'mouseover',
        maxColumn: 85,
        scale: 1
      },
      padding: { top: 8, bottom: 16 },
      guides: { indentation: true, bracketPairs: false },
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      scrollbar: {
        verticalScrollbarSize: 8,
        horizontalScrollbarSize: 8,
        useShadows: false
      }
    })

    const getCurrentNav = () => {
      const cur = activeTabRef.current
      const pos = ed.getPosition()
      if (!cur || cur.isDiff || !pos) return undefined
      return { envId: cur.envId, path: cur.path, line: pos.lineNumber, column: pos.column }
    }

    bindSublimeKeybindings(ed, {
      onSave: () => {
        const cur = activeTabRef.current
        if (cur) void saveTab(cur.id)
      },
      onSwitchHeaderSource: () => {
        const cur = activeTabRef.current
        if (!cur || cur.isDiff) return
        void switchCppHeaderSource(cur.envId, cur.path).then((ok) => {
          if (!ok) {
            useAppStore.getState().addToast('info', `No matching header/source found for ${cur.name}`)
          }
        })
      },
      onNavigateBack: () => {
        void useAppStore.getState().navigateBack(getCurrentNav())
      },
      onNavigateForward: () => {
        void useAppStore.getState().navigateForward(getCurrentNav())
      }
    })

    const subChange = ed.onDidChangeModelContent(() => {
      const cur = activeTabRef.current
      if (!cur || cur.loading || cur.isBinary || cur.error || cur.isDiff) return
      // Only accept edits from the model that actually belongs to the current tab (a stale model left
      // attached to a hidden pane must never write file A's text into file B's tab!)
      const model = ed.getModel()
      if (!model || model.uri.toString() !== tabModelUri(cur.envId, cur.path).toString()) return
      const val = model.getValue()
      if (val !== cur.content) {
        updateTabContent(cur.id, val)
      }
    })

    const subCursor = ed.onDidChangeCursorPosition((e) => {
      const cur = activeTabRef.current
      setCursorInfo({
        line: e.position.lineNumber,
        column: e.position.column,
        language: cur?.language || 'plaintext'
      })
    })

    const subFocus = ed.onDidFocusEditorText(() => {
      setEditorFocusGroup(group)
      setActiveFocusArea('editor')
    })

    editorRef.current = ed
    registerMonacoEditor(`pane-${group}`, ed)

    return () => {
      unregisterMonacoEditor(`pane-${group}`, ed)
      subChange.dispose()
      subCursor.dispose()
      subFocus.dispose()
      ed.dispose()
      editorRef.current = null
    }
  }, [isDiff, group])

  useEffect(() => {
    monaco.editor.setTheme(getMonacoThemeName(theme))
  }, [theme])

  useEffect(() => {
    const lineHeight = Math.round(editorFontSize * 1.52)
    editorRef.current?.updateOptions({ fontSize: editorFontSize, lineHeight })
    diffEditorRef.current?.updateOptions({ fontSize: editorFontSize, lineHeight })
  }, [editorFontSize])

  useEffect(() => {
    if (!tab || tab.loading || tab.isBinary || tab.error) {
      // Detach any previous file's model so this (hidden) editor can't keep mutating another tab
      if (editorRef.current?.getModel()) editorRef.current.setModel(null)
      return
    }

    if (isDiff && diffEditorRef.current && tab.diffOriginal) {
      const diffEd = diffEditorRef.current
      const origModel = monaco.editor.createModel(tab.diffOriginal.content, tab.language)
      const modModel = monaco.editor.createModel(tab.content, tab.language)
      diffEd.setModel({ original: origModel, modified: modModel })
      return () => {
        // Reset the widget BEFORE disposing its models (Monaco throws/logs otherwise)
        try {
          diffEd.setModel(null)
        } catch {
          // editor already disposed
        }
        origModel.dispose()
        modModel.dispose()
      }
    }

    const ed = editorRef.current
    if (!ed) return

    const uri = tabModelUri(tab.envId, tab.path)
    let model = monaco.editor.getModel(uri)
    if (!model) {
      model = monaco.editor.createModel(tab.content, tab.language, uri)
    } else {
      if (model.getValue() !== tab.content) {
        model.setValue(tab.content)
      }
      if (model.getLanguageId() !== tab.language) {
        monaco.editor.setModelLanguage(model, tab.language)
      }
    }

    if (ed.getModel() !== model) {
      ed.setModel(model)
    }
    ed.updateOptions({ readOnly: Boolean(tab.readOnly) })

    const curPos = ed.getPosition()
    setCursorInfo({
      line: curPos?.lineNumber ?? 1,
      column: curPos?.column ?? 1,
      language: tab.language
    })

    if (tab.pendingPosition) {
      const { line, column } = tab.pendingPosition
      ed.revealPositionInCenter({ lineNumber: line, column })
      ed.setPosition({ lineNumber: line, column })
      ed.focus()
      clearPendingPosition(tab.id)
    }
  }, [tab?.id, tab?.loading, tab?.isBinary, tab?.error, tab?.readOnly, tab?.pendingPosition, isDiff])

  const handleDropFile = (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData('application/x-multiplex-entry')
    if (!raw) return
    e.preventDefault()
    try {
      const entry = JSON.parse(raw) as { envId: string; path: string; isDirectory: boolean }
      if (!entry.isDirectory) {
        void openFile(entry.envId, entry.path, undefined, group)
      }
    } catch {
      // ignore
    }
  }

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{ backgroundColor: 'var(--st-editor)' }}
      onMouseDown={() => {
        setEditorFocusGroup(group)
        setActiveFocusArea('editor')
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-multiplex-entry')) {
          e.preventDefault()
        }
      }}
      onDrop={handleDropFile}
    >
      <div
        ref={containerRef}
        className={`h-full w-full ${!tab || tab.loading || tab.isBinary || tab.error ? 'hidden' : 'block'}`}
      />

      {tab && tab.readOnly && !tab.loading && !tab.error && !tab.isBinary && (
        <div
          className="pointer-events-none absolute right-4 top-2 z-10 rounded border px-2 py-0.5 text-[11px] font-mono"
          style={{
            backgroundColor: 'var(--st-panel)',
            borderColor: 'var(--st-dirty)',
            color: 'var(--st-dirty)'
          }}
        >
          Read-only · {tab.encoding || 'non-UTF-8'} file (saving would corrupt it)
        </div>
      )}

      {!tab && (
        <div
          className="flex h-full w-full flex-col items-center justify-center gap-5 px-6 select-none"
          style={{ color: 'var(--st-text-dim)' }}
        >
          <div className="flex flex-col items-center gap-2.5">
            <img
              src={logoUrl}
              alt="MultiplexIDE"
              className="h-[72px] w-[72px] rounded-[16px] shadow-2xl"
              draggable={false}
            />
            <div className="text-[22px] font-semibold tracking-tight" style={{ color: 'var(--st-text)' }}>
              MultiplexIDE
            </div>
            <div className="text-[12.5px]" style={{ color: 'var(--st-text-muted)' }}>
              Multi-Environment Code Editor · Resilient Split Terminal · Fast SFTP
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2.5 w-full max-w-[440px]">
            <button
              onClick={() => useAppStore.getState().setShowQuickOpen(true)}
              className="flex items-center justify-between rounded border px-3 py-2 text-[12.5px] transition-colors hover:bg-white/5"
              style={{ borderColor: 'var(--st-border-light)', backgroundColor: 'var(--st-panel)', color: 'var(--st-text)' }}
            >
              <span className="flex items-center gap-2">
                <FileSearch className="h-4 w-4" style={{ color: 'var(--st-accent-blue)' }} />
                Goto Files
              </span>
              <kbd className="font-mono text-[11px] opacity-60">⌘P</kbd>
            </button>

            <button
              onClick={() => useAppStore.getState().setShowSearchPanel(true)}
              className="flex items-center justify-between rounded border px-3 py-2 text-[12.5px] transition-colors hover:bg-white/5"
              style={{ borderColor: 'var(--st-border-light)', backgroundColor: 'var(--st-panel)', color: 'var(--st-text)' }}
            >
              <span className="flex items-center gap-2">
                <Search className="h-4 w-4" style={{ color: 'var(--st-accent)' }} />
                Find in Files
              </span>
              <kbd className="font-mono text-[11px] opacity-60">⌘⇧F</kbd>
            </button>

            <button
              onClick={() => void useAppStore.getState().createTerminalTab(useAppStore.getState().activeEnvId)}
              className="flex items-center justify-between rounded border px-3 py-2 text-[12.5px] transition-colors hover:bg-white/5"
              style={{ borderColor: 'var(--st-border-light)', backgroundColor: 'var(--st-panel)', color: 'var(--st-text)' }}
            >
              <span className="flex items-center gap-2">
                <Terminal className="h-4 w-4" style={{ color: 'var(--st-dirty)' }} />
                New Terminal Tab
              </span>
              <kbd className="font-mono text-[11px] opacity-60">⌘⇧T</kbd>
            </button>

            <button
              onClick={() => void useAppStore.getState().openConfigFile()}
              className="flex items-center justify-between rounded border px-3 py-2 text-[12.5px] transition-colors hover:bg-white/5"
              style={{ borderColor: 'var(--st-border-light)', backgroundColor: 'var(--st-panel)', color: 'var(--st-text)' }}
            >
              <span className="flex items-center gap-2">
                <Settings className="h-4 w-4" style={{ color: 'var(--st-purple)' }} />
                Edit Config
              </span>
              <kbd className="font-mono text-[11px] opacity-60">⌘,</kbd>
            </button>
          </div>

          <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-[12px] font-mono opacity-65 pt-1">
            <span>Go to Definition</span>
            <span>⌘+Click / F12</span>
            <span>Find References</span>
            <span>Hover / ⇧F12</span>
            <span>Goto Symbol in File</span>
            <span>⌘R / ⌘⇧O</span>
            <span>Switch .h ↔ .cpp</span>
            <span>⌥⌘O</span>
            <span>Navigate Back / Fwd</span>
            <span>⌃- / ⌃⇧-</span>
            <span>Split Terminal</span>
            <span>⌘D / ⌘⇧D</span>
          </div>
        </div>
      )}

      {tab?.loading && (
        <div className="flex h-full w-full items-center justify-center text-[13px]" style={{ color: 'var(--st-text-muted)' }}>
          Opening {tab.name}...
        </div>
      )}

      {tab?.error && (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center text-[13px]">
          <div style={{ color: 'var(--st-red)' }}>Unable to read {tab.name}</div>
          <div className="font-mono text-[12px]" style={{ color: 'var(--st-text-muted)' }}>
            {tab.error}
          </div>
        </div>
      )}

      {tab?.isBinary && !tab.loading && !tab.error && (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-[13px]">
          <div style={{ color: 'var(--st-text-muted)' }}>Binary file is not displayed in text view</div>
          <div className="font-mono text-[12px]" style={{ color: 'var(--st-text-dim)' }}>
            {tab.path}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Interactive floating Symbol References & Definitions Overlay (`⇧F12` or Hover "All References").
 */
const SymbolReferencesOverlay: React.FC = () => {
  const overlay = useAppStore((s) => s.symbolRefsOverlay)
  const setSymbolRefsOverlay = useAppStore((s) => s.setSymbolRefsOverlay)

  const [filter, setFilter] = useState('')
  const [tabFilter, setTabFilter] = useState<'all' | 'defs' | 'file'>('all')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!overlay) return
    setFilter('')
    setTabFilter('all')
    setSelectedIdx(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [overlay?.symbol, overlay?.envId])

  const filtered = useMemo(() => {
    if (!overlay) return []
    let items = overlay.occurrences.filter((o) => o.kind !== 'comment')
    if (tabFilter === 'defs') {
      items = items.filter((o) => o.kind === 'definition' || o.kind === 'declaration')
    } else if (tabFilter === 'file') {
      items = items.filter((o) => o.filePath === overlay.currentFilePath)
    }
    const q = filter.trim().toLowerCase()
    if (q) {
      items = items.filter(
        (o) => o.relativePath.toLowerCase().includes(q) || o.lineText.toLowerCase().includes(q)
      )
    }
    return items
  }, [overlay, filter, tabFilter])

  useEffect(() => {
    setSelectedIdx((i) => Math.min(i, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  if (!overlay) return null

  const nonComment = overlay.occurrences.filter((o) => o.kind !== 'comment')
  const defCount = nonComment.filter((o) => o.kind === 'definition' || o.kind === 'declaration').length
  const fileCount = nonComment.filter((o) => o.filePath === overlay.currentFilePath).length

  const openOccurrence = (occ: (typeof filtered)[number], keepOpen: boolean) => {
    void jumpToCodeLocation(occ.envId, occ.filePath, occ.line, occ.column)
    if (!keepOpen) setSymbolRefsOverlay(null)
  }

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      className="absolute top-2 right-3 z-40 flex w-[520px] max-w-[92%] max-h-[70%] flex-col rounded-md border shadow-2xl overflow-hidden text-[12px]"
      style={{
        backgroundColor: 'rgba(24, 25, 21, 0.96)',
        borderColor: 'var(--st-border-light)',
        backdropFilter: 'blur(16px)'
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between gap-2 px-3 py-2 border-b"
        style={{ borderColor: 'var(--st-border)' }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono font-semibold truncate" style={{ color: 'var(--st-accent)' }}>
            {overlay.symbol}
          </span>
          <span className="font-mono text-[10.5px] shrink-0" style={{ color: 'var(--st-text-dim)' }}>
            {nonComment.length}
            {overlay.truncated ? '+' : ''} refs
          </span>
          {overlay.loading && (
            <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" style={{ color: 'var(--st-accent-blue)' }} />
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {(
            [
              ['all', `All (${nonComment.length})`],
              ['defs', `Defs (${defCount})`],
              ['file', `This File (${fileCount})`]
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => {
                setTabFilter(id)
                setSelectedIdx(0)
              }}
              className="rounded px-1.5 py-0.5 text-[10.5px] font-mono transition-colors"
              style={{
                backgroundColor: tabFilter === id ? 'rgba(255,255,255,0.14)' : 'transparent',
                color: tabFilter === id ? 'var(--st-text)' : 'var(--st-text-dim)'
              }}
            >
              {label}
            </button>
          ))}
          <button
            onClick={() => setSymbolRefsOverlay(null)}
            title="Close (Esc)"
            className="ml-1 rounded p-0.5 hover:bg-white/10"
            style={{ color: 'var(--st-text-dim)' }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Filter box */}
      <div
        className="flex items-center gap-1.5 px-3 py-1.5 border-b"
        style={{ borderColor: 'var(--st-border)', backgroundColor: 'rgba(0,0,0,0.2)' }}
      >
        <Search className="h-3.5 w-3.5 opacity-50 shrink-0" />
        <input
          ref={inputRef}
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value)
            setSelectedIdx(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              setSymbolRefsOverlay(null)
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSelectedIdx((i) => Math.min(Math.max(0, filtered.length - 1), i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSelectedIdx((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter' && filtered[selectedIdx]) {
              e.preventDefault()
              openOccurrence(filtered[selectedIdx], e.metaKey || e.shiftKey)
            }
          }}
          placeholder="Filter references... (⏎ jump · ⌘⏎ jump & keep open)"
          className="w-full bg-transparent font-mono text-[11.5px] outline-none"
          style={{ color: 'var(--st-text)' }}
        />
      </div>

      {/* Results list */}
      <div className="flex-1 overflow-y-auto py-1">
        {filtered.length === 0 ? (
          <div className="px-4 py-6 text-center font-mono text-[11.5px]" style={{ color: 'var(--st-text-dim)' }}>
            {overlay.loading ? 'Scanning workspace...' : 'No matching references'}
          </div>
        ) : (
          filtered.map((occ, idx) => {
            const selected = idx === selectedIdx
            const isDef = occ.kind === 'definition'
            const isDecl = occ.kind === 'declaration'
            const isCurFile = occ.filePath === overlay.currentFilePath
            return (
              <div
                key={`${occ.filePath}:${occ.line}:${occ.column}:${idx}`}
                onMouseEnter={() => setSelectedIdx(idx)}
                onClick={(e) => openOccurrence(occ, e.metaKey || e.shiftKey)}
                className="flex flex-col gap-0.5 px-3 py-1.5 cursor-pointer border-b border-white/[0.03]"
                style={{
                  backgroundColor: selected ? 'rgba(255, 255, 255, 0.09)' : 'transparent'
                }}
              >
                <div className="flex items-center justify-between gap-2 text-[11px] font-mono">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {(isDef || isDecl) && (
                      <span
                        className="rounded px-1 py-0 text-[9.5px] font-semibold uppercase shrink-0"
                        style={{
                          backgroundColor: isDef ? 'rgba(166, 226, 46, 0.18)' : 'rgba(102, 217, 239, 0.18)',
                          color: isDef ? 'var(--st-green)' : 'var(--st-accent-blue)'
                        }}
                      >
                        {isDef ? 'def' : 'decl'}
                      </span>
                    )}
                    <span
                      className="truncate"
                      style={{ color: isCurFile ? 'var(--st-accent-blue)' : 'var(--st-text-muted)' }}
                    >
                      {occ.relativePath}
                    </span>
                  </div>
                  <span className="shrink-0 tabular-nums" style={{ color: 'var(--st-text-dim)' }}>
                    :{occ.line}
                  </span>
                </div>
                <div
                  className="truncate font-mono text-[11.5px]"
                  style={{ color: selected ? 'var(--st-text)' : 'var(--st-text-muted)' }}
                >
                  {occ.lineText.trim()}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

export const EditorWorkbench: React.FC = () => {
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const secondaryTabId = useAppStore((s) => s.secondaryTabId)
  const editorColumns = useAppStore((s) => s.editorColumns)
  const editorFocusGroup = useAppStore((s) => s.editorFocusGroup)
  const environments = useAppStore((s) => s.environments)
  const navBackStack = useAppStore((s) => s.navBackStack)
  const navForwardStack = useAppStore((s) => s.navForwardStack)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const closeTab = useAppStore((s) => s.closeTab)
  const saveTab = useAppStore((s) => s.saveTab)
  const openDiffTab = useAppStore((s) => s.openDiffTab)
  const navigateBack = useAppStore((s) => s.navigateBack)
  const navigateForward = useAppStore((s) => s.navigateForward)

  const [showDiffPicker, setShowDiffPicker] = useState(false)

  useEffect(() => {
    if (!showDiffPicker) return
    const close = () => setShowDiffPicker(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [showDiffPicker])

  const primaryTab = tabs.find((t) => t.id === activeTabId) || null
  const secondaryTab = tabs.find((t) => t.id === secondaryTabId) || null
  const focusedTab = editorFocusGroup === 1 && editorColumns === 2 ? secondaryTab : primaryTab
  const envMap = new Map(environments.map((e) => [e.id, e]))
  const canSwitchHeader = Boolean(
    focusedTab && !focusedTab.isDiff && (isHeaderPath(focusedTab.path) || isSourcePath(focusedTab.path))
  )

  const currentNavLoc = focusedTab && !focusedTab.isDiff
    ? {
        envId: focusedTab.envId,
        path: focusedTab.path,
        line: useAppStore.getState().cursorInfo.line || 1,
        column: useAppStore.getState().cursorInfo.column || 1
      }
    : undefined

  return (
    <div className="flex h-full w-full flex-col overflow-hidden" style={{ backgroundColor: 'var(--st-editor)' }}>
      {/* Authentic Sublime Text 3 Tab Strip + Navigation Controls */}
      <div
        className="flex h-[36px] shrink-0 items-end justify-between pr-2"
        style={{ backgroundColor: 'var(--st-tabbar)' }}
      >
        <div className="flex h-full flex-1 items-end overflow-x-auto pl-1.5">
          {tabs.map((tab) => {
            const isPrimary = tab.id === activeTabId
            const isSecondary = editorColumns === 2 && tab.id === secondaryTabId
            const isActive = editorFocusGroup === 0 ? isPrimary : isSecondary || isPrimary
            const env = envMap.get(tab.envId)

            return (
              <div
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                onAuxClick={(e) => {
                  if (e.button === 1) closeTab(tab.id)
                }}
                className={`st3-tab group shrink-0 max-w-[260px] gap-1.5 ${isActive ? 'st3-tab-active' : ''}`}
                title={`${env?.name || tab.envId}:${tab.path}`}
              >
                {tab.isDiff ? (
                  <GitCompare className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--st-accent-blue)' }} />
                ) : (
                  <FileIcon name={tab.name} size={14} />
                )}
                <span className="truncate">{tab.name}</span>

                {env && env.kind === 'ssh' && (
                  <span className="ml-1.5 text-[11px] font-mono opacity-55 shrink-0">
                    · {env.name}
                  </span>
                )}

                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(tab.id)
                  }}
                  className="ml-2 flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-white/10"
                  title={tab.isDirty ? 'Unsaved changes' : 'Close (⌘W)'}
                >
                  {tab.isDirty ? (
                    <>
                      <span
                        className="h-2 w-2 rounded-full group-hover:hidden"
                        style={{ backgroundColor: 'var(--st-dirty)' }}
                      />
                      <X className="hidden h-3.5 w-3.5 group-hover:block" />
                    </>
                  ) : (
                    <X className="h-3.5 w-3.5 opacity-40 group-hover:opacity-100" />
                  )}
                </button>
              </div>
            )
          })}
        </div>

        <div className="relative flex h-full items-center gap-0.5 pl-2">
          {/* Jump Back / Forward History Controls (`⌃-` / `⌃⇧-`) */}
          {(navBackStack.length > 0 || navForwardStack.length > 0) && (
            <>
              <button
                onClick={() => void navigateBack(currentNavLoc)}
                disabled={navBackStack.length === 0}
                title="Navigate Back (⌃-)"
                className="rounded p-1 hover:bg-white/10 disabled:opacity-25"
                style={{ color: 'var(--st-text-dim)' }}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => void navigateForward(currentNavLoc)}
                disabled={navForwardStack.length === 0}
                title="Navigate Forward (⌃⇧-)"
                className="rounded p-1 hover:bg-white/10 disabled:opacity-25"
                style={{ color: 'var(--st-text-dim)' }}
              >
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </>
          )}

          {/* Switch C/C++ Header ↔ Source (`⌥⌘O`) */}
          {canSwitchHeader && focusedTab && (
            <button
              onClick={() => {
                void switchCppHeaderSource(focusedTab.envId, focusedTab.path).then((ok) => {
                  if (!ok) {
                    useAppStore.getState().addToast('info', `No matching header/source found for ${focusedTab.name}`)
                  }
                })
              }}
              title="Switch Header / Source (⌥⌘O)"
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-mono hover:bg-white/10"
              style={{ color: 'var(--st-accent-blue)' }}
            >
              <ArrowLeftRight className="h-3 w-3" />
              <span>{isHeaderPath(focusedTab.path) ? '.cpp' : '.h'}</span>
            </button>
          )}

          {/* Goto Symbol Outline (`⌘R` / `⌘⇧O`) */}
          {focusedTab && !focusedTab.isDiff && !focusedTab.isBinary && (
            <button
              onClick={() => {
                const editors = monaco.editor.getEditors()
                const targetUri = tabModelUri(focusedTab.envId, focusedTab.path).toString()
                const ed = editors.find((e) => e.getModel()?.uri.toString() === targetUri) || editors[0]
                if (ed) {
                  ed.focus()
                  ed.trigger('toolbar', 'editor.action.quickOutline', null)
                }
              }}
              title="Goto Symbol in File (⌘R / ⌘⇧O)"
              className="rounded p-1 hover:bg-white/10"
              style={{ color: 'var(--st-text-dim)' }}
            >
              <ListTree className="h-3.5 w-3.5" />
            </button>
          )}

          {focusedTab && !focusedTab.isDiff && focusedTab.isDirty && (
            <button
              onClick={() => void saveTab(focusedTab.id)}
              title="Save (⌘S)"
              className="ml-1 flex items-center gap-1 rounded px-2.5 py-0.5 text-[11.5px] font-medium text-[#111]"
              style={{ backgroundColor: 'var(--st-dirty)' }}
            >
              <Save className="h-3.5 w-3.5" />
              <span>Save</span>
            </button>
          )}

          {tabs.filter((t) => !t.isDiff).length >= 2 && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setShowDiffPicker((v) => !v)
              }}
              title="Diff active file with another open tab"
              className="flex items-center gap-1 rounded p-1 hover:bg-white/10"
              style={{ color: 'var(--st-text-dim)' }}
            >
              <GitCompare className="h-4 w-4" />
            </button>
          )}

          {showDiffPicker && focusedTab && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute right-0 top-[36px] z-40 w-[270px] rounded border py-1 shadow-2xl text-[12px]"
              style={{ backgroundColor: 'var(--st-panel)', borderColor: 'var(--st-border-light)' }}
            >
              <div className="px-2.5 py-1 text-[11px] uppercase font-semibold" style={{ color: 'var(--st-text-dim)' }}>
                Compare {focusedTab.name} with...
              </div>
              {tabs
                .filter((t) => !t.isDiff && t.id !== focusedTab.id)
                .map((other) => {
                  const oEnv = envMap.get(other.envId)
                  return (
                    <button
                      key={other.id}
                      onClick={() => {
                        openDiffTab(other.id, focusedTab.id)
                        setShowDiffPicker(false)
                      }}
                      className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left hover:bg-white/10"
                    >
                      <span className="truncate">{other.name}</span>
                      <span className="font-mono text-[11px] opacity-55">{oEnv?.name}</span>
                    </button>
                  )
                })}
            </div>
          )}
        </div>
      </div>

      <div className="relative flex-1 min-h-0 w-full">
        {editorColumns === 1 ? (
          <MonacoPane tab={primaryTab} group={0} />
        ) : (
          <Allotment proportionalLayout>
            <Allotment.Pane minSize={220}>
              <MonacoPane tab={primaryTab} group={0} />
            </Allotment.Pane>
            <Allotment.Pane minSize={220}>
              <MonacoPane tab={secondaryTab} group={1} />
            </Allotment.Pane>
          </Allotment>
        )}

        <SymbolReferencesOverlay />
      </div>
    </div>
  )
}
