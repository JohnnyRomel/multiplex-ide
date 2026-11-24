import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, Square, X } from 'lucide-react'
import type { SearchMatch } from '@shared/types'
import { useAppStore } from '@renderer/stores/useAppStore'

/**
 * Authentic Sublime Text 3 Bottom "Find in Files" panel.
 */
export const GlobalSearchPanel: React.FC = () => {
  const environments = useAppStore((s) => s.environments)
  const activeEnvId = useAppStore((s) => s.activeEnvId)
  const envRootPaths = useAppStore((s) => s.envRootPaths)
  const searchQuery = useAppStore((s) => s.searchQuery)
  const searchRunning = useAppStore((s) => s.searchRunning)
  const searchMatches = useAppStore((s) => s.searchMatches)
  const searchDone = useAppStore((s) => s.searchDone)
  const searchEnvIds = useAppStore((s) => s.searchEnvIds)

  const setSearchQuery = useAppStore((s) => s.setSearchQuery)
  const setSearchEnvIds = useAppStore((s) => s.setSearchEnvIds)
  const startGlobalSearch = useAppStore((s) => s.startGlobalSearch)
  const cancelGlobalSearch = useAppStore((s) => s.cancelGlobalSearch)
  const setShowSearchPanel = useAppStore((s) => s.setShowSearchPanel)
  const openFile = useAppStore((s) => s.openFile)

  const [isRegex, setIsRegex] = useState(false)
  const [isCaseSensitive, setIsCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [wherePath, setWherePath] = useState('')
  const [includeGlob, setIncludeGlob] = useState('')
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set())
  const findInputRef = useRef<HTMLInputElement>(null)

  const envMap = new Map(environments.map((e) => [e.id, e]))
  const selectedIds = searchEnvIds.length > 0 ? searchEnvIds : [activeEnvId]

  // Keep Where path synced with active environment's current folder when single env is selected
  useEffect(() => {
    if (selectedIds.length === 1) {
      const id = selectedIds[0]
      const env = envMap.get(id)
      setWherePath(envRootPaths[id] || env?.defaultPath || '~')
    }
  }, [activeEnvId, envRootPaths, selectedIds.join(',')])

  useEffect(() => {
    requestAnimationFrame(() => findInputRef.current?.focus())
  }, [])

  const toggleTargetEnv = (envId: string) => {
    const current = new Set(selectedIds)
    if (current.has(envId)) {
      if (current.size > 1) current.delete(envId)
    } else {
      current.add(envId)
    }
    setSearchEnvIds(Array.from(current))
  }

  const grouped = useMemo(() => {
    const map = new Map<string, { envId: string; filePath: string; relativePath: string; items: SearchMatch[] }>()
    for (const m of searchMatches) {
      const key = `${m.envId}::${m.filePath}`
      let group = map.get(key)
      if (!group) {
        group = { envId: m.envId, filePath: m.filePath, relativePath: m.relativePath, items: [] }
        map.set(key, group)
      }
      group.items.push(m)
    }
    return Array.from(map.values())
  }, [searchMatches])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    void startGlobalSearch({
      query: searchQuery,
      customPath: selectedIds.length === 1 ? wherePath : undefined,
      isRegex,
      isCaseSensitive,
      wholeWord,
      includeGlob,
      excludeGlob: ''
    })
  }

  const stToggle = (active: boolean, label: string, title: string, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="h-[24px] w-[26px] rounded-sm border font-mono text-[11px] transition-colors"
      style={{
        backgroundColor: active ? 'var(--st-sidebar-active)' : 'var(--st-input)',
        borderColor: active ? 'var(--st-accent)' : 'var(--st-border-light)',
        color: active ? 'var(--st-accent)' : 'var(--st-text-dim)'
      }}
    >
      {label}
    </button>
  )

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden border-t"
      style={{ backgroundColor: 'var(--st-panel)', borderColor: 'var(--st-border)' }}
    >
      {/* Sublime Text 3 Find Results Buffer Area (Top) + Compact Input Strip */}
      <form
        onSubmit={handleSubmit}
        className="shrink-0 space-y-1.5 border-b px-3 py-2"
        style={{ backgroundColor: 'var(--st-tabbar)', borderColor: 'var(--st-border)' }}
      >
        {/* Row 1: Find */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 shrink-0">
            {stToggle(isRegex, '.*', 'Regular expression', () => setIsRegex((v) => !v))}
            {stToggle(isCaseSensitive, 'Aa', 'Case sensitive', () => setIsCaseSensitive((v) => !v))}
            {stToggle(wholeWord, '\\b', 'Whole word', () => setWholeWord((v) => !v))}
          </div>

          <span className="w-[42px] text-right text-[11px] shrink-0" style={{ color: 'var(--st-text-muted)' }}>
            Find:
          </span>

          <input
            ref={findInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setShowSearchPanel(false)
            }}
            placeholder="Find text across files (Enter to search)..."
            className="flex-1 rounded-sm border px-2 py-1 font-mono text-[12px] outline-none"
            style={{
              backgroundColor: 'var(--st-input)',
              borderColor: 'var(--st-border-light)',
              color: 'var(--st-text)'
            }}
          />

          {searchRunning ? (
            <button
              type="button"
              onClick={cancelGlobalSearch}
              className="flex items-center gap-1 rounded-sm border px-3 py-1 text-[11px]"
              style={{
                backgroundColor: 'var(--st-sidebar-active)',
                borderColor: 'var(--st-red)',
                color: 'var(--st-red)'
              }}
            >
              <Square className="h-2.5 w-2.5" /> Cancel
            </button>
          ) : (
            <button
              type="submit"
              className="rounded-sm border px-3.5 py-1 text-[11px] font-medium hover:brightness-110"
              style={{
                backgroundColor: 'var(--st-sidebar-active)',
                borderColor: 'var(--st-border-light)',
                color: 'var(--st-text)'
              }}
            >
              Find
            </button>
          )}

          <button
            type="button"
            onClick={() => setShowSearchPanel(false)}
            className="rounded p-1 hover:bg-white/10"
            style={{ color: 'var(--st-text-dim)' }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Row 2: Where (Directory + File Filter + Workspaces) */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1 shrink-0">
            {environments.map((env) => {
              const selected = selectedIds.includes(env.id)
              return (
                <button
                  key={env.id}
                  type="button"
                  onClick={() => toggleTargetEnv(env.id)}
                  className="flex items-center gap-1 rounded-sm border px-2 py-0.5 font-mono text-[10.5px]"
                  style={{
                    backgroundColor: selected ? 'var(--st-sidebar-active)' : 'var(--st-input)',
                    borderColor: selected ? env.color : 'var(--st-border)',
                    color: selected ? 'var(--st-text)' : 'var(--st-text-dim)'
                  }}
                  title={`Include ${env.name} in search`}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{
                      backgroundColor:
                        env.status === 'connected' ? 'var(--st-green)' : 'var(--st-text-dim)'
                    }}
                  />
                  <span>{env.name}</span>
                </button>
              )
            })}
          </div>

          <span className="w-[42px] text-right text-[11px] shrink-0" style={{ color: 'var(--st-text-muted)' }}>
            Where:
          </span>

          {selectedIds.length === 1 ? (
            <input
              value={wherePath}
              onChange={(e) => setWherePath(e.target.value)}
              placeholder="Directory path..."
              className="flex-1 min-w-[160px] rounded-sm border px-2 py-0.5 font-mono text-[11px] outline-none"
              style={{
                backgroundColor: 'var(--st-input)',
                borderColor: 'var(--st-border-light)',
                color: 'var(--st-text-muted)'
              }}
            />
          ) : (
            <span className="flex-1 font-mono text-[11px]" style={{ color: 'var(--st-text-dim)' }}>
              Searching {selectedIds.length} workspace roots simultaneously
            </span>
          )}

          <input
            value={includeGlob}
            onChange={(e) => setIncludeGlob(e.target.value)}
            placeholder="Filter (e.g. *.ts,*.py)"
            className="w-[155px] rounded-sm border px-2 py-0.5 font-mono text-[11px] outline-none"
            style={{
              backgroundColor: 'var(--st-input)',
              borderColor: 'var(--st-border-light)',
              color: 'var(--st-text-muted)'
            }}
          />

          <div className="flex items-center gap-1.5 text-[10.5px] font-mono shrink-0" style={{ color: 'var(--st-text-dim)' }}>
            {searchRunning && <Loader2 className="h-3 w-3 animate-spin" style={{ color: 'var(--st-accent)' }} />}
            {searchDone && (
              <span>
                {searchDone.totalMatches} matches across {grouped.length} files ({searchDone.durationMs}ms)
              </span>
            )}
          </div>
        </div>
      </form>

      {/* Sublime Find Results Buffer Style Output */}
      <div
        className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[11.5px]"
        style={{ backgroundColor: 'var(--st-editor)' }}
      >
        {searchDone?.errors && searchDone.errors.length > 0 && (
          <div className="mb-2 rounded px-2.5 py-1.5 text-[11px]" style={{ backgroundColor: 'rgba(249,38,114,0.14)', color: 'var(--st-red)' }}>
            {searchDone.errors.map((e) => `${envMap.get(e.envId)?.name || e.envId}: ${e.message}`).join(' · ')}
          </div>
        )}

        {grouped.length === 0 && !searchRunning ? (
          <div className="py-6 text-center font-sans text-[11.5px]" style={{ color: 'var(--st-text-dim)' }}>
            Type a search pattern above and press Enter.
          </div>
        ) : (
          grouped.map((g) => {
            const key = `${g.envId}::${g.filePath}`
            const collapsed = collapsedFiles.has(key)
            const env = envMap.get(g.envId)
            return (
              <div key={key} className="mb-2">
                <div
                  onClick={() =>
                    setCollapsedFiles((prev) => {
                      const next = new Set(prev)
                      if (next.has(key)) next.delete(key)
                      else next.add(key)
                      return next
                    })
                  }
                  className="flex items-center gap-1.5 py-0.5 cursor-pointer hover:opacity-90"
                >
                  {collapsed ? (
                    <ChevronRight className="h-3 w-3 shrink-0" style={{ color: 'var(--st-text-dim)' }} />
                  ) : (
                    <ChevronDown className="h-3 w-3 shrink-0" style={{ color: 'var(--st-text-dim)' }} />
                  )}
                  <span style={{ color: 'var(--st-accent)' }}>
                    {env && env.kind === 'ssh' ? `[${env.name}] ` : ''}
                    {g.filePath}:
                  </span>
                  <span className="text-[10.5px]" style={{ color: 'var(--st-text-dim)' }}>
                    ({g.items.length})
                  </span>
                </div>

                {!collapsed &&
                  g.items.map((m, i) => {
                    const startIdx = Math.max(0, m.column - 1)
                    const endIdx = Math.min(m.lineText.length, startIdx + m.matchLength)
                    const before = m.lineText.slice(0, startIdx)
                    const hit = m.lineText.slice(startIdx, endIdx)
                    const after = m.lineText.slice(endIdx)
                    return (
                      <div
                        key={`${m.line}-${m.column}-${i}`}
                        onClick={() => void openFile(m.envId, m.filePath, { line: m.line, column: m.column })}
                        className="flex items-baseline gap-2 pl-5 pr-2 py-0.5 cursor-pointer hover:bg-white/5"
                      >
                        <span className="w-[42px] shrink-0 text-right" style={{ color: 'var(--st-text-dim)' }}>
                          {m.line}:
                        </span>
                        <span className="truncate" style={{ color: 'var(--st-text)' }}>
                          {before}
                          <span
                            className="px-0.5 font-semibold"
                            style={{
                              backgroundColor: 'rgba(230, 219, 116, 0.22)',
                              outline: '1px solid var(--st-yellow)',
                              color: 'var(--st-yellow)'
                            }}
                          >
                            {hit}
                          </span>
                          {after}
                        </span>
                      </div>
                    )
                  })}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
