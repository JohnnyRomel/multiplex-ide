import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Globe, Loader2 } from 'lucide-react'
import type { QuickOpenFile } from '@shared/types'
import { useAppStore } from '@renderer/stores/useAppStore'

/**
 * Computes highlight character indices preferring contiguous substring matches FIRST
 * (so searching `feature_handler.cpp` in `tiktok_monarch_feature_handler.cpp` highlights
 * the exact `[feature_handler.cpp]` suffix rather than scattered early letters!).
 */
function getHighlightIndices(text: string, rawQuery: string): Set<number> {
  const hit = new Set<number>()
  const q = rawQuery.trim().toLowerCase()
  if (!q) return hit
  const lower = text.toLowerCase()

  // 1. Exact contiguous substring match (prefer rightmost in filename/path)
  const lastIdx = lower.lastIndexOf(q)
  if (lastIdx >= 0) {
    for (let i = lastIdx; i < lastIdx + q.length; i++) hit.add(i)
    return hit
  }

  // 2. Multi-token contiguous matches ("monarch handler")
  const tokens = q.split(/\s+/).filter(Boolean)
  if (tokens.length > 1 && tokens.every((tok) => lower.includes(tok))) {
    for (const tok of tokens) {
      const idx = lower.lastIndexOf(tok)
      if (idx >= 0) {
        for (let i = idx; i < idx + tok.length; i++) hit.add(i)
      }
    }
    return hit
  }

  // 3. Fallback subsequence match
  const compact = q.replace(/\s+/g, '')
  let pos = 0
  for (let i = 0; i < compact.length; i++) {
    const idx = lower.indexOf(compact[i], pos)
    if (idx < 0) return new Set()
    hit.add(idx)
    pos = idx + 1
  }
  return hit
}

function localRankScore(file: QuickOpenFile, rawQuery: string): number {
  const q = rawQuery.trim().toLowerCase()
  if (!q) return 1
  const name = file.name.toLowerCase()
  const rel = file.relativePath.toLowerCase()
  const tokens = q.split(/\s+/).filter(Boolean)

  if (name === q) return 10000
  if (name.endsWith(q)) return 8500 - file.name.length * 2
  if (name.startsWith(q)) return 7800 - file.name.length * 2
  const nIdx = name.indexOf(q)
  if (nIdx >= 0) return 7000 - nIdx * 3 - file.name.length
  if (rel.includes(q)) return 5500 - file.relativePath.length * 0.5
  if (tokens.length > 1 && tokens.every((t) => name.includes(t))) return 4800 - file.name.length
  if (tokens.length > 1 && tokens.every((t) => rel.includes(t))) return 3600 - file.relativePath.length * 0.4

  const compact = q.replace(/\s+/g, '')
  let pos = 0
  for (let i = 0; i < compact.length; i++) {
    const found = rel.indexOf(compact[i], pos)
    if (found < 0) return -1
    pos = found + 1
  }
  return 300 - file.relativePath.length * 0.2
}

const HighlightedText: React.FC<{ text: string; query: string }> = ({ text, query }) => {
  const hitSet = useMemo(() => getHighlightIndices(text, query), [text, query])
  if (hitSet.size === 0) return <span>{text}</span>
  return (
    <span>
      {Array.from(text).map((ch, i) =>
        hitSet.has(i) ? (
          <span key={i} className="font-semibold" style={{ color: 'var(--st-accent)' }}>
            {ch}
          </span>
        ) : (
          <span key={i}>{ch}</span>
        )
      )}
    </span>
  )
}

/**
 * Sublime Text 3 Goto Anything (Cmd+P) with live server-side search across massive monorepos.
 * Searching `feature_handler.cpp` queries `rg --files -L` + server-side filter directly on dev92/cn_a10/local
 * so files like `tiktok_monarch_feature_handler.cpp` at any depth or past 100k+ files are found immediately!
 */
export const QuickOpenModal: React.FC = () => {
  const show = useAppStore((s) => s.showQuickOpen)
  const setShow = useAppStore((s) => s.setShowQuickOpen)
  const activeEnvId = useAppStore((s) => s.activeEnvId)
  const environments = useAppStore((s) => s.environments)
  const envRootPaths = useAppStore((s) => s.envRootPaths)
  const tabs = useAppStore((s) => s.tabs)
  const openFile = useAppStore((s) => s.openFile)
  const ensureTerminalForEnv = useAppStore((s) => s.ensureTerminalForEnv)
  const addToast = useAppStore((s) => s.addToast)

  const [query, setQuery] = useState('')
  const [allEnvs, setAllEnvs] = useState(false)
  const [serverFiles, setServerFiles] = useState<QuickOpenFile[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const activeReqIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (show) {
      setQuery('')
      setSelectedIdx(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    } else if (activeReqIdRef.current) {
      void window.multiplex.cancelFileSearch(activeReqIdRef.current)
      activeReqIdRef.current = null
    }
  }, [show])

  const { pathQuery, targetLine } = useMemo(() => {
    const trimmed = query.trim()
    const colonIdx = trimmed.lastIndexOf(':')
    if (colonIdx >= 0) {
      const num = parseInt(trimmed.slice(colonIdx + 1), 10)
      if (Number.isFinite(num) && num > 0) {
        return { pathQuery: trimmed.slice(0, colonIdx), targetLine: num }
      }
    }
    return { pathQuery: trimmed, targetLine: undefined }
  }, [query])

  const activeRoot = envRootPaths[activeEnvId] || environments.find((e) => e.id === activeEnvId)?.defaultPath || '~'

  // Live server-side file search (90ms debounce when typing, instant when opening!)
  useEffect(() => {
    if (!show) return
    let cancelled = false
    const reqId = `fsearch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

    const timer = setTimeout(
      async () => {
        if (activeReqIdRef.current) {
          void window.multiplex.cancelFileSearch(activeReqIdRef.current)
        }
        activeReqIdRef.current = reqId
        setLoading(true)

        try {
          const state = useAppStore.getState()
          const targets = allEnvs
            ? state.environments
            : state.environments.filter((e) => e.id === activeEnvId)

          const results = await Promise.all(
            targets.map((e) => {
              const root = state.envRootPaths[e.id] || e.defaultPath
              return window.multiplex
                .searchFilesQuery(e.id, root, pathQuery, `${reqId}-${e.id}`, pathQuery ? 200 : 300)
                .catch(() => [])
            })
          )
          if (!cancelled) {
            setServerFiles(results.flat())
          }
        } finally {
          if (!cancelled) setLoading(false)
        }
      },
      pathQuery ? 90 : 0
    )

    return () => {
      cancelled = true
      clearTimeout(timer)
      void window.multiplex.cancelFileSearch(reqId)
    }
  }, [show, allEnvs, activeEnvId, activeRoot, pathQuery])

  // Merge matching open tabs + server-returned files and sort by Sublime match rank
  const ranked = useMemo(() => {
    const seen = new Set<string>()
    const merged: QuickOpenFile[] = []

    for (const tab of tabs) {
      if (tab.isDiff) continue
      if (!allEnvs && tab.envId !== activeEnvId) continue
      const key = `${tab.envId}::${tab.path}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push({
        envId: tab.envId,
        filePath: tab.path,
        relativePath: tab.path.replace(/^\/Users\/[^/]+/, '~'),
        name: tab.name
      })
    }

    for (const f of serverFiles) {
      const key = `${f.envId}::${f.filePath}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(f)
    }

    if (!pathQuery) return merged.slice(0, 120)

    return merged
      .map((f) => ({ file: f, score: localRankScore(f, pathQuery) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 120)
      .map((x) => x.file)
  }, [tabs, serverFiles, allEnvs, activeEnvId, pathQuery])

  useEffect(() => {
    setSelectedIdx(0)
  }, [pathQuery])

  useEffect(() => {
    const el = listRef.current?.children[selectedIdx] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  if (!show) return null

  const envMap = new Map(environments.map((e) => [e.id, e]))
  const activeEnv = envMap.get(activeEnvId)

  const handleSelect = (item: QuickOpenFile) => {
    setShow(false)
    void openFile(item.envId, item.filePath, targetLine ? { line: targetLine, column: 1 } : undefined)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[36px] bg-black/30"
      onClick={() => setShow(false)}
    >
      <div
        className="w-[640px] max-w-[92vw] rounded-b border shadow-2xl overflow-hidden"
        style={{ backgroundColor: 'var(--st-panel)', borderColor: 'var(--st-border-light)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sublime Goto Anything Input */}
        <div className="flex items-center gap-2 p-2 border-b" style={{ borderColor: 'var(--st-border)' }}>
          <div className="relative flex-1 flex items-center">
            <input
              ref={inputRef}
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setShow(false)
                } else if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setSelectedIdx((i) => Math.min(Math.max(0, ranked.length - 1), i + 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setSelectedIdx((i) => Math.max(0, i - 1))
                } else if (e.key === 'Enter' && ranked[selectedIdx]) {
                  e.preventDefault()
                  handleSelect(ranked[selectedIdx])
                }
              }}
              placeholder="Goto Anything — e.g. feature_handler.cpp or file.py:42 ..."
              className="w-full rounded border pl-2.5 pr-7 py-1.5 font-mono text-[13px] outline-none"
              style={{
                backgroundColor: 'var(--st-input)',
                borderColor: 'var(--st-border-light)',
                color: 'var(--st-text)'
              }}
            />
            {loading && (
              <Loader2
                className="absolute right-2 h-3.5 w-3.5 animate-spin"
                style={{ color: 'var(--st-accent)' }}
              />
            )}
          </div>

          <button
            type="button"
            onClick={() => setAllEnvs((v) => !v)}
            title="Toggle between Active Workspace and All Workspaces"
            className="flex items-center gap-1 rounded border px-2.5 py-1.5 text-[11px] font-mono shrink-0"
            style={{
              backgroundColor: allEnvs ? 'var(--st-sidebar-active)' : 'var(--st-input)',
              borderColor: allEnvs ? 'var(--st-accent)' : 'var(--st-border-light)',
              color: allEnvs ? 'var(--st-text)' : 'var(--st-text-muted)'
            }}
          >
            <Globe className="h-3 w-3" />
            <span>{allEnvs ? 'All Workspaces' : activeEnv?.name || 'Current'}</span>
          </button>
        </div>

        {/* File Results */}
        <div ref={listRef} className="max-h-[390px] overflow-y-auto py-0.5">
          {ranked.length === 0 ? (
            <div className="px-4 py-6 text-center text-[12px] space-y-2" style={{ color: 'var(--st-text-dim)' }}>
              {loading ? (
                <div className="flex items-center justify-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Searching {activeRoot}...</span>
                </div>
              ) : activeEnv?.kind === 'ssh' && activeEnv.status !== 'connected' ? (
                <div className="space-y-2">
                  <div>{activeEnv.name} is not connected yet.</div>
                  <button
                    onClick={async () => {
                      const res = await window.multiplex.connectEnvironment(activeEnv.id)
                      if (res.ok) {
                        const list = await window.multiplex.searchFilesQuery(
                          activeEnv.id,
                          activeRoot,
                          pathQuery,
                          `manual-${Date.now()}`,
                          200
                        )
                        setServerFiles(list)
                      } else if (res.needsInteractiveAuth) {
                        setShow(false)
                        addToast('info', `Complete SSH login in ${activeEnv.name} terminal first`)
                        await ensureTerminalForEnv(activeEnv.id)
                      }
                    }}
                    className="rounded px-3 py-1 text-[11px] font-medium text-[#111]"
                    style={{ backgroundColor: 'var(--st-accent)' }}
                  >
                    Connect {activeEnv.name}
                  </button>
                </div>
              ) : (
                <div>No files matching "{pathQuery}" in {activeRoot}</div>
              )}
            </div>
          ) : (
            ranked.map((item, idx) => {
              const env = envMap.get(item.envId)
              const selected = idx === selectedIdx
              return (
                <div
                  key={`${item.envId}::${item.filePath}`}
                  onMouseEnter={() => setSelectedIdx(idx)}
                  onClick={() => handleSelect(item)}
                  className="flex items-baseline justify-between gap-3 px-3 py-1.5 cursor-pointer"
                  style={{
                    backgroundColor: selected ? 'var(--st-sidebar-active)' : 'transparent'
                  }}
                >
                  <div className="flex items-baseline gap-2.5 min-w-0">
                    <span className="text-[12.5px] font-medium shrink-0" style={{ color: 'var(--st-text)' }}>
                      <HighlightedText text={item.name} query={pathQuery} />
                      {targetLine ? (
                        <span className="ml-1 font-mono text-[11px]" style={{ color: 'var(--st-accent)' }}>
                          :{targetLine}
                        </span>
                      ) : null}
                    </span>
                    <span className="truncate font-mono text-[11px]" style={{ color: 'var(--st-text-dim)' }}>
                      <HighlightedText text={item.relativePath} query={pathQuery} />
                    </span>
                  </div>

                  {env && (allEnvs || env.kind === 'ssh') && (
                    <span className="font-mono text-[10px] shrink-0" style={{ color: 'var(--st-text-muted)' }}>
                      {env.name}
                    </span>
                  )}
                </div>
              )
            })
          )}
        </div>

        <div
          className="flex items-center justify-between px-3 py-1 border-t text-[10.5px] font-mono"
          style={{ borderColor: 'var(--st-border)', color: 'var(--st-text-dim)', backgroundColor: 'var(--st-titlebar)' }}
        >
          <span className="truncate">
            Search root: {allEnvs ? 'All Workspaces' : `${activeEnv?.name || ''}:${activeRoot}`}
          </span>
          <span>{loading ? 'Searching...' : `${ranked.length} matches`}</span>
        </div>
      </div>
    </div>
  )
}
