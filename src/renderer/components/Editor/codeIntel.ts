import * as monaco from 'monaco-editor'
import {
  extractCppQualifier,
  extractDocumentSymbols,
  findInFileOccurrences,
  getSiblingHeaderSourceCandidates,
  isNavigableSymbol,
  parseCppIncludeAtLine,
  rankSymbolMatches,
  type DocumentSymbolEntry,
  type SymbolOccurrence
} from '@shared/symbolIntel'
import { useAppStore } from '@renderer/stores/useAppStore'

export const CODE_INTEL_LANGUAGES = ['cpp', 'c', 'python', 'shell', 'typescript', 'javascript', 'go', 'rust']

export function tabModelUri(envId: string, filePath: string): monaco.Uri {
  const normalizedPath = filePath.startsWith('/') ? filePath : `/${filePath}`
  return monaco.Uri.from({
    scheme: 'multiplex',
    authority: encodeURIComponent(envId),
    path: normalizedPath
  })
}

export function parseTabModelUri(uri: monaco.Uri): { envId: string; filePath: string } | null {
  if (uri.scheme !== 'multiplex') return null
  try {
    const envId = decodeURIComponent(uri.authority)
    const filePath = uri.path
    if (!envId || !filePath) return null
    return { envId, filePath }
  } catch {
    return null
  }
}

interface CacheEntry {
  timestamp: number
  occurrences: SymbolOccurrence[]
  truncated: boolean
}

const SYMBOL_CACHE_TTL_MS = 15_000
const SYMBOL_CACHE_MAX = 60
const symbolCache = new Map<string, CacheEntry>()
const symbolInFlight = new Map<string, Promise<{ occurrences: SymbolOccurrence[]; truncated: boolean }>>()

function getWorkspaceRootForEnv(envId: string, fallbackFilePath: string): string {
  const s = useAppStore.getState()
  const root = s.envRootPaths[envId] || s.environments.find((e) => e.id === envId)?.defaultPath
  if (root) return root
  const slash = fallbackFilePath.lastIndexOf('/')
  return slash > 0 ? fallbackFilePath.slice(0, slash) : '/'
}

function toRelativePath(filePath: string, rootPath: string): string {
  const cleanRoot = rootPath.replace(/\/+$/, '')
  if (cleanRoot && filePath.startsWith(cleanRoot + '/')) {
    return filePath.slice(cleanRoot.length + 1)
  }
  return filePath
}

function getActiveEditorNavLocation(): { envId: string; path: string; line: number; column: number } | null {
  const s = useAppStore.getState()
  const activeId = s.editorColumns === 2 && s.editorFocusGroup === 1 ? s.secondaryTabId : s.activeTabId
  const tab = s.tabs.find((t) => t.id === activeId)
  if (!tab || tab.isDiff) return null
  return {
    envId: tab.envId,
    path: tab.path,
    line: s.cursorInfo.line || 1,
    column: s.cursorInfo.column || 1
  }
}

export async function jumpToCodeLocation(
  envId: string,
  filePath: string,
  line: number,
  column = 1
): Promise<void> {
  const s = useAppStore.getState()
  const cur = getActiveEditorNavLocation()
  if (cur && !(cur.envId === envId && cur.path === filePath && Math.abs(cur.line - line) <= 1)) {
    s.pushNavLocation(cur)
  }
  await s.openFile(envId, filePath, { line, column })
}

/**
 * Queries live current-file occurrences merged with cached workspace `rg` symbol occurrences.
 */
export async function querySymbolMerged(params: {
  model: monaco.editor.ITextModel
  symbol: string
  currentLine?: number
  qualifier?: string
  slot?: string
  maxResults?: number
  skipCache?: boolean
}): Promise<{ occurrences: SymbolOccurrence[]; truncated: boolean }> {
  const parsed = parseTabModelUri(params.model.uri)
  if (!parsed) return { occurrences: [], truncated: false }
  const { envId, filePath } = parsed
  const language = params.model.getLanguageId()
  const rootPath = getWorkspaceRootForEnv(envId, filePath)
  const relPath = toRelativePath(filePath, rootPath)

  // Always scan the live (possibly unsaved) Monaco buffer for instant, accurate current-file matches
  const inFile = findInFileOccurrences(params.model.getValue(), params.symbol, {
    envId,
    filePath,
    relativePath: relPath,
    language
  })

  const cacheKey = `${envId}::${rootPath}::${language}::${params.symbol}`
  const now = Date.now()
  let workspaceResult: { occurrences: SymbolOccurrence[]; truncated: boolean } | null = null

  if (!params.skipCache) {
    const cached = symbolCache.get(cacheKey)
    if (cached && now - cached.timestamp < SYMBOL_CACHE_TTL_MS) {
      workspaceResult = { occurrences: cached.occurrences, truncated: cached.truncated }
    }
  }

  if (!workspaceResult) {
    let inflight = symbolInFlight.get(cacheKey)
    if (!inflight) {
      inflight = window.multiplex
        .querySymbolReferences({
          envId,
          rootPath,
          symbol: params.symbol,
          currentFilePath: filePath,
          currentLine: params.currentLine,
          language,
          qualifier: params.qualifier,
          maxResults: params.maxResults ?? 80,
          slot: params.slot || 'hover'
        })
        .then((res) => {
          if (symbolCache.size >= SYMBOL_CACHE_MAX) {
            const oldestKey = symbolCache.keys().next().value
            if (oldestKey) symbolCache.delete(oldestKey)
          }
          symbolCache.set(cacheKey, {
            timestamp: Date.now(),
            occurrences: res.occurrences,
            truncated: res.truncated
          })
          return res
        })
        .catch(() => ({ occurrences: [], truncated: false }))
        .finally(() => {
          if (symbolInFlight.get(cacheKey) === inflight) {
            symbolInFlight.delete(cacheKey)
          }
        })
      symbolInFlight.set(cacheKey, inflight)
    }
    workspaceResult = await inflight
  }

  // Merge live current-file hits + other-file workspace hits and re-rank for current cursor context
  const otherFiles = workspaceResult.occurrences.filter((o) => o.filePath !== filePath)
  const merged = rankSymbolMatches([...inFile, ...otherFiles], {
    symbol: params.symbol,
    currentFilePath: filePath,
    currentLine: params.currentLine,
    language,
    qualifier: params.qualifier
  })

  return { occurrences: merged, truncated: workspaceResult.truncated }
}

/**
 * Resolves a C/C++ `#include "foo/bar.h"` or `<foo/bar.h>` target to a concrete workspace file path.
 */
export async function resolveIncludeFilePath(
  envId: string,
  currentFilePath: string,
  includeTarget: string
): Promise<string | null> {
  const rootPath = getWorkspaceRootForEnv(envId, currentFilePath)
  const slash = currentFilePath.lastIndexOf('/')
  const curDir = slash > 0 ? currentFilePath.slice(0, slash) : '/'
  const cleanRoot = rootPath.replace(/\/+$/, '')

  const directCandidates = Array.from(
    new Set([
      `${curDir}/${includeTarget}`,
      `${cleanRoot}/${includeTarget}`,
      `${cleanRoot}/include/${includeTarget}`,
      `${cleanRoot}/src/${includeTarget}`
    ])
  )

  for (const candidate of directCandidates) {
    try {
      const st = await window.multiplex.statFile(envId, candidate)
      if (st && !st.isDirectory) return st.path
    } catch {
      // try next
    }
  }

  // Fallback: query workspace files by include path/basename
  try {
    const reqId = `inc-${Date.now().toString(36)}`
    const files = await window.multiplex.searchFilesQuery(envId, rootPath, includeTarget, reqId, 20)
    const exactSuffix = files.find(
      (f) => f.filePath.endsWith(`/${includeTarget}`) || f.relativePath === includeTarget
    )
    if (exactSuffix) return exactSuffix.filePath
    const base = includeTarget.split('/').pop() || includeTarget
    const byName = files.find((f) => f.name === base)
    if (byName) return byName.filePath
  } catch {
    // ignore
  }
  return null
}

/**
 * Switches between C/C++ header (`.h`/`.hpp`) and implementation (`.cpp`/`.cc`) files (`⌥⌘O`).
 */
export async function switchCppHeaderSource(envId: string, currentFilePath: string): Promise<boolean> {
  const candidates = getSiblingHeaderSourceCandidates(currentFilePath)
  if (candidates.length === 0) return false

  for (const candidate of candidates) {
    try {
      const st = await window.multiplex.statFile(envId, candidate)
      if (st && !st.isDirectory) {
        await jumpToCodeLocation(envId, st.path, 1, 1)
        return true
      }
    } catch {
      // try next
    }
  }

  // Fallback: search workspace for sibling basename with opposite extension
  const rootPath = getWorkspaceRootForEnv(envId, currentFilePath)
  const targetNames = new Set(candidates.map((c) => c.split('/').pop() || ''))
  const stem = (currentFilePath.split('/').pop() || '').replace(/\.[^.]+$/, '')
  if (!stem) return false

  try {
    const reqId = `hdr-${Date.now().toString(36)}`
    const files = await window.multiplex.searchFilesQuery(envId, rootPath, stem, reqId, 30)
    const match = files.find((f) => f.filePath !== currentFilePath && targetNames.has(f.name))
    if (match) {
      await jumpToCodeLocation(envId, match.filePath, 1, 1)
      return true
    }
  } catch {
    // ignore
  }
  return false
}

/**
 * Opens the floating interactive Symbol References & Definitions Overlay (`⇧F12` or Hover action).
 */
export async function openReferencesOverlayForEditor(
  editor: monaco.editor.ICodeEditor,
  overrideSymbol?: string
): Promise<void> {
  const model = editor.getModel()
  const pos = editor.getPosition()
  if (!model || !pos) return
  const parsed = parseTabModelUri(model.uri)
  if (!parsed) return

  const wordObj = model.getWordAtPosition(pos)
  const symbol = overrideSymbol || wordObj?.word || ''
  if (!symbol || !isNavigableSymbol(symbol, model.getLanguageId())) return

  const lineText = model.getLineContent(pos.lineNumber)
  const qualifier = extractCppQualifier(lineText, wordObj?.startColumn ?? pos.column)
  const rootPath = getWorkspaceRootForEnv(parsed.envId, parsed.filePath)
  const inFile = findInFileOccurrences(model.getValue(), symbol, {
    envId: parsed.envId,
    filePath: parsed.filePath,
    relativePath: toRelativePath(parsed.filePath, rootPath),
    language: model.getLanguageId()
  })

  // Open immediately with in-file hits while workspace query completes in background
  useAppStore.getState().setSymbolRefsOverlay({
    symbol,
    envId: parsed.envId,
    currentFilePath: parsed.filePath,
    loading: true,
    occurrences: inFile,
    truncated: false
  })

  const res = await querySymbolMerged({
    model,
    symbol,
    currentLine: pos.lineNumber,
    qualifier,
    slot: 'refs',
    maxResults: 120
  })

  // Only update if user didn't close or switch to a different symbol overlay
  const latest = useAppStore.getState().symbolRefsOverlay
  if (latest && latest.symbol === symbol && latest.envId === parsed.envId) {
    useAppStore.getState().setSymbolRefsOverlay({
      symbol,
      envId: parsed.envId,
      currentFilePath: parsed.filePath,
      loading: false,
      occurrences: res.occurrences,
      truncated: res.truncated
    })
  }
}

function escapeMdInline(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/([`*_{}[\]()#+\-.!|<>])/g, '\\$1')
}

function trimSnippet(lineText: string, maxLen = 78): string {
  const compact = lineText.trim().replace(/\s+/g, ' ')
  return compact.length > maxLen ? `${compact.slice(0, maxLen - 1)}…` : compact
}

function makeCommandUri(cmd: string, args: unknown[]): string {
  return `command:${cmd}?${encodeURIComponent(JSON.stringify(args))}`
}

function mapSymbolKind(kind: DocumentSymbolEntry['kind']): monaco.languages.SymbolKind {
  switch (kind) {
    case 'class':
      return monaco.languages.SymbolKind.Class
    case 'struct':
      return monaco.languages.SymbolKind.Struct
    case 'enum':
      return monaco.languages.SymbolKind.Enum
    case 'namespace':
      return monaco.languages.SymbolKind.Namespace
    case 'method':
      return monaco.languages.SymbolKind.Method
    case 'macro':
      return monaco.languages.SymbolKind.Constant
    case 'type':
      return monaco.languages.SymbolKind.Interface
    default:
      return monaco.languages.SymbolKind.Function
  }
}

let providersRegistered = false

/**
 * Registers all lightweight non-LSP Monaco providers ONCE:
 * - Hover References & Definitions card (with clickable cross-file jump links!)
 * - `⌘+Click` / `F12` Go-to-Definition (C++ symbols + `#include` header jumping!)
 * - `⇧F12` Find All References (interactive multi-file overlay!)
 * - Automatic cursor Document Highlights (all occurrences in current file)
 * - `⌘⇧O` / `⌘R` Document Symbol Outline
 */
export function registerCodeIntelligence(): void {
  if (providersRegistered) return
  providersRegistered = true

  // 1. Clickable hover command links
  monaco.editor.registerCommand('mide.openLoc', (_accessor, envId: string, filePath: string, line: number, column: number) => {
    if (envId && filePath) {
      void jumpToCodeLocation(envId, filePath, line || 1, column || 1)
    }
  })

  monaco.editor.registerCommand('mide.openInclude', (_accessor, envId: string, currentFilePath: string, target: string) => {
    if (!envId || !currentFilePath || !target) return
    void resolveIncludeFilePath(envId, currentFilePath, target).then((resolved) => {
      if (resolved) {
        void jumpToCodeLocation(envId, resolved, 1, 1)
      } else {
        useAppStore.getState().addToast('info', `Header not found in workspace: ${target}`)
      }
    })
  })

  monaco.editor.registerCommand(
    'mide.openRefs',
    (_accessor, envId: string, filePath: string, symbol: string, line: number, language: string, qualifier?: string) => {
      const uri = tabModelUri(envId, filePath)
      const model = monaco.editor.getModel(uri)
      if (!model) return
      const rootPath = getWorkspaceRootForEnv(envId, filePath)
      const inFile = findInFileOccurrences(model.getValue(), symbol, {
        envId,
        filePath,
        relativePath: toRelativePath(filePath, rootPath),
        language
      })
      useAppStore.getState().setSymbolRefsOverlay({
        symbol,
        envId,
        currentFilePath: filePath,
        loading: true,
        occurrences: inFile,
        truncated: false
      })
      void querySymbolMerged({
        model,
        symbol,
        currentLine: line,
        qualifier,
        slot: 'refs',
        maxResults: 120
      }).then((res) => {
        const latest = useAppStore.getState().symbolRefsOverlay
        if (latest && latest.symbol === symbol && latest.envId === envId) {
          useAppStore.getState().setSymbolRefsOverlay({
            symbol,
            envId,
            currentFilePath: filePath,
            loading: false,
            occurrences: res.occurrences,
            truncated: res.truncated
          })
        }
      })
    }
  )

  monaco.editor.registerCommand('mide.searchProject', (_accessor, symbol: string) => {
    if (!symbol) return
    const s = useAppStore.getState()
    s.setSearchQuery(symbol)
    s.setShowSearchPanel(true)
    void s.startGlobalSearch({
      query: symbol,
      isRegex: false,
      isCaseSensitive: true,
      wholeWord: true,
      includeGlob: '',
      excludeGlob: ''
    })
  })

  // 2. Cross-file opener for native `⌘+Click` / `F12` Go-to-Definition
  monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selectionOrPosition) {
      const target = parseTabModelUri(resource)
      if (!target) return false
      const srcModel = source.getModel()
      const srcPos = source.getPosition()
      const srcParsed = srcModel ? parseTabModelUri(srcModel.uri) : null
      if (srcParsed && srcPos) {
        useAppStore.getState().pushNavLocation({
          envId: srcParsed.envId,
          path: srcParsed.filePath,
          line: srcPos.lineNumber,
          column: srcPos.column
        })
      }
      let line = 1
      let column = 1
      if (selectionOrPosition) {
        if ('startLineNumber' in selectionOrPosition) {
          line = selectionOrPosition.startLineNumber
          column = selectionOrPosition.startColumn
        } else if ('lineNumber' in selectionOrPosition) {
          line = selectionOrPosition.lineNumber
          column = selectionOrPosition.column
        }
      }
      void useAppStore.getState().openFile(target.envId, target.filePath, { line, column })
      return true
    }
  })

  // 3. Hover Provider: hover any symbol to see its Definitions + In-File & Workspace References!
  monaco.languages.registerHoverProvider(CODE_INTEL_LANGUAGES, {
    async provideHover(model, position, token) {
      const parsed = parseTabModelUri(model.uri)
      if (!parsed) return null

      const lineText = model.getLineContent(position.lineNumber)
      const lang = model.getLanguageId()

      // Special case: C/C++ `#include "foo/bar.h"` hover -> 1-click header jump
      if (lang === 'cpp' || lang === 'c') {
        const inc = parseCppIncludeAtLine(lineText)
        if (inc && position.column >= inc.startCol && position.column <= inc.endCol) {
          const cmd = makeCommandUri('mide.openInclude', [parsed.envId, parsed.filePath, inc.target])
          return {
            range: new monaco.Range(position.lineNumber, inc.startCol, position.lineNumber, inc.endCol),
            contents: [
              {
                value: `**#include** \`${inc.target}\`  \n[Open Header (⌘+Click)](${cmd})`,
                isTrusted: true
              }
            ]
          }
        }
      }

      const wordObj = model.getWordAtPosition(position)
      if (!wordObj || !isNavigableSymbol(wordObj.word, lang)) return null

      const symbol = wordObj.word
      const qualifier = extractCppQualifier(lineText, wordObj.startColumn)
      const range = new monaco.Range(position.lineNumber, wordObj.startColumn, position.lineNumber, wordObj.endColumn)

      const res = await querySymbolMerged({
        model,
        symbol,
        currentLine: position.lineNumber,
        qualifier,
        slot: 'hover',
        maxResults: 60
      })
      if (token.isCancellationRequested) return null

      const all = res.occurrences.filter((o) => o.kind !== 'comment')
      if (all.length === 0) return null

      const defs = all.filter((o) => o.kind === 'definition' || o.kind === 'declaration')
      const inFileRefs = all.filter((o) => o.filePath === parsed.filePath)
      const otherFileRefs = all.filter((o) => o.filePath !== parsed.filePath && o.kind === 'reference')
      const uniqueFiles = new Set(all.map((o) => o.filePath)).size
      const countSuffix = res.truncated ? '+' : ''

      const mdParts: monaco.IMarkdownString[] = []

      // Header summary
      const qualPrefix = qualifier ? `${qualifier}::` : ''
      mdParts.push({
        value: `**\`${qualPrefix}${symbol}\`** · ${defs.length > 0 ? `${defs.length} def${defs.length > 1 ? 's' : ''} · ` : ''}${all.length}${countSuffix} ref${all.length > 1 ? 's' : ''} across ${uniqueFiles} file${uniqueFiles > 1 ? 's' : ''}`,
        isTrusted: true
      })

      // Definitions / Declarations (up to 4)
      if (defs.length > 0) {
        const lines = defs.slice(0, 4).map((d) => {
          const shortName = d.relativePath.split('/').slice(-2).join('/')
          const link = makeCommandUri('mide.openLoc', [d.envId, d.filePath, d.line, d.column])
          const tag = d.kind === 'definition' ? 'def' : 'decl'
          return `- **${tag}** [${escapeMdInline(shortName)}:${d.line}](${link}) — \`${trimSnippet(d.lineText, 64).replace(/`/g, "'")}\``
        })
        mdParts.push({
          value: `**Definitions**\n${lines.join('\n')}`,
          isTrusted: true
        })
      }

      // Current-file references (up to 6)
      if (inFileRefs.length > 0) {
        const lines = inFileRefs.slice(0, 6).map((r) => {
          const link = makeCommandUri('mide.openLoc', [r.envId, r.filePath, r.line, r.column])
          const marker = r.line === position.lineNumber ? ' *(current)*' : ''
          return `- [:${r.line}](${link})${marker} — \`${trimSnippet(r.lineText, 68).replace(/`/g, "'")}\``
        })
        const more = inFileRefs.length > 6 ? `\n- *…+${inFileRefs.length - 6} more in this file*` : ''
        mdParts.push({
          value: `**This File (${inFileRefs.length})**\n${lines.join('\n')}${more}`,
          isTrusted: true
        })
      }

      // Cross-file references (up to 6)
      if (otherFileRefs.length > 0) {
        const lines = otherFileRefs.slice(0, 6).map((r) => {
          const shortName = r.relativePath.split('/').slice(-2).join('/')
          const link = makeCommandUri('mide.openLoc', [r.envId, r.filePath, r.line, r.column])
          return `- [${escapeMdInline(shortName)}:${r.line}](${link}) — \`${trimSnippet(r.lineText, 62).replace(/`/g, "'")}\``
        })
        const more =
          otherFileRefs.length > 6 || res.truncated
            ? `\n- *…more matches in workspace*`
            : ''
        mdParts.push({
          value: `**Workspace References**\n${lines.join('\n')}${more}`,
          isTrusted: true
        })
      }

      // Footer quick actions
      const refsCmd = makeCommandUri('mide.openRefs', [
        parsed.envId,
        parsed.filePath,
        symbol,
        position.lineNumber,
        lang,
        qualifier || ''
      ])
      const searchCmd = makeCommandUri('mide.searchProject', [symbol])
      mdParts.push({
        value: `[All References (⇧F12)](${refsCmd}) · [Search in Project](${searchCmd})`,
        isTrusted: true
      })

      return { range, contents: mdParts }
    }
  })

  // 4. Definition Provider (`⌘+Click` / `F12` — fast C++ & multi-language jump!)
  monaco.languages.registerDefinitionProvider(CODE_INTEL_LANGUAGES, {
    async provideDefinition(model, position, token): Promise<monaco.languages.LocationLink[] | null> {
      const parsed = parseTabModelUri(model.uri)
      if (!parsed) return null

      const lineText = model.getLineContent(position.lineNumber)
      const lang = model.getLanguageId()

      // C/C++ `#include "..."` jump
      if (lang === 'cpp' || lang === 'c') {
        const inc = parseCppIncludeAtLine(lineText)
        if (inc && position.column >= inc.startCol && position.column <= inc.endCol) {
          const resolved = await resolveIncludeFilePath(parsed.envId, parsed.filePath, inc.target)
          if (!resolved || token.isCancellationRequested) return null
          return [
            {
              originSelectionRange: new monaco.Range(position.lineNumber, inc.startCol, position.lineNumber, inc.endCol),
              uri: tabModelUri(parsed.envId, resolved),
              range: new monaco.Range(1, 1, 1, 1)
            }
          ]
        }
      }

      const wordObj = model.getWordAtPosition(position)
      if (!wordObj || !isNavigableSymbol(wordObj.word, lang)) return null

      const qualifier = extractCppQualifier(lineText, wordObj.startColumn)
      const res = await querySymbolMerged({
        model,
        symbol: wordObj.word,
        currentLine: position.lineNumber,
        qualifier,
        slot: 'def',
        maxResults: 60
      })
      if (token.isCancellationRequested || res.occurrences.length === 0) return null

      // Prefer a definition/declaration NOT on the exact line we're standing on
      const notSelf = res.occurrences.filter(
        (o) => !(o.filePath === parsed.filePath && o.line === position.lineNumber) && o.kind !== 'comment'
      )
      if (notSelf.length === 0) return null

      const best =
        notSelf.find((o) => o.kind === 'definition') ||
        notSelf.find((o) => o.kind === 'declaration') ||
        notSelf[0]

      return [
        {
          originSelectionRange: new monaco.Range(
            position.lineNumber,
            wordObj.startColumn,
            position.lineNumber,
            wordObj.endColumn
          ),
          uri: tabModelUri(best.envId, best.filePath),
          range: new monaco.Range(best.line, best.column, best.line, best.column + best.matchLength)
        }
      ]
    }
  })

  // 5. Document Highlight Provider (0ms highlighting of all occurrences in current file on cursor move)
  monaco.languages.registerDocumentHighlightProvider(CODE_INTEL_LANGUAGES, {
    provideDocumentHighlights(model, position) {
      const wordObj = model.getWordAtPosition(position)
      if (!wordObj || !isNavigableSymbol(wordObj.word, model.getLanguageId())) return []
      const parsed = parseTabModelUri(model.uri)
      const hits = findInFileOccurrences(model.getValue(), wordObj.word, {
        envId: parsed?.envId || 'local',
        filePath: parsed?.filePath || '',
        relativePath: '',
        language: model.getLanguageId()
      })
      return hits.map((h) => ({
        range: new monaco.Range(h.line, h.column, h.line, h.column + h.matchLength),
        kind:
          h.kind === 'definition' || h.kind === 'declaration'
            ? monaco.languages.DocumentHighlightKind.Write
            : monaco.languages.DocumentHighlightKind.Read
      }))
    }
  })

  // 6. Document Symbol Provider (`⌘⇧O` / `⌘R` Goto Symbol in File)
  monaco.languages.registerDocumentSymbolProvider(CODE_INTEL_LANGUAGES, {
    provideDocumentSymbols(model) {
      const extracted = extractDocumentSymbols(model.getValue(), model.getLanguageId())
      return extracted.map((sym) => {
        const range = new monaco.Range(sym.line, 1, sym.line, model.getLineMaxColumn(sym.line))
        const selRange = new monaco.Range(sym.line, sym.column, sym.line, sym.endColumn)
        return {
          name: sym.name,
          detail: sym.detail || '',
          kind: mapSymbolKind(sym.kind),
          tags: [],
          range,
          selectionRange: selRange
        }
      })
    }
  })
}
