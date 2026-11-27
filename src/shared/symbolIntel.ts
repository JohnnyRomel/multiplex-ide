/**
 * Lightweight, zero-LSP Code Intelligence utilities for C/C++, Python, Shell, TS/JS, Go, and Rust.
 * Works identically on local workspaces and remote SSH monorepos via fast ripgrep queries:
 * - Symbol extraction for `⌘⇧O` / `⌘R` Document Outline
 * - Smart classification (`definition` / `declaration` / `reference` / `comment`) & ranking
 * - C/C++ `#include "..."` / `<...>` target detection & `.h` ↔ `.cpp` header/source switching
 */

export type SymbolMatchKind = 'definition' | 'declaration' | 'reference' | 'comment'

export interface SymbolOccurrence {
  envId: string
  filePath: string
  relativePath: string
  line: number
  column: number
  matchLength: number
  lineText: string
  kind: SymbolMatchKind
  score: number
}

export interface DocumentSymbolEntry {
  name: string
  detail?: string
  kind: 'class' | 'struct' | 'enum' | 'namespace' | 'function' | 'method' | 'macro' | 'type'
  line: number
  column: number
  endColumn: number
}

const NON_NAVIGABLE_KEYWORDS = new Set([
  // C / C++
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'return', 'goto', 'try', 'catch', 'throw', 'new', 'delete', 'sizeof', 'alignof',
  'decltype', 'typeid', 'noexcept', 'public', 'private', 'protected', 'friend', 'using',
  'namespace', 'template', 'typename', 'class', 'struct', 'enum', 'union', 'typedef',
  'const', 'constexpr', 'consteval', 'volatile', 'mutable', 'static', 'extern', 'inline',
  'virtual', 'override', 'final', 'explicit', 'auto', 'void', 'bool', 'char', 'short',
  'int', 'long', 'signed', 'unsigned', 'float', 'double', 'true', 'false', 'nullptr',
  'NULL', 'this', 'std', 'include', 'define', 'ifdef', 'ifndef', 'endif', 'pragma',
  'static_cast', 'dynamic_cast', 'const_cast', 'reinterpret_cast', 'static_assert',
  // Python
  'def', 'async', 'await', 'import', 'from', 'as', 'pass', 'raise', 'with', 'yield',
  'lambda', 'and', 'or', 'not', 'in', 'is', 'None', 'True', 'False', 'self', 'cls', 'elif',
  // JS / TS
  'function', 'var', 'let', 'export', 'interface', 'type', 'extends', 'implements',
  'undefined', 'null', 'super', 'typeof', 'instanceof', 'of',
  // Shell
  'then', 'fi', 'done', 'esac', 'echo', 'local', 'unset', 'shift', 'exit',
  // Go / Rust
  'func', 'fn', 'pub', 'mut', 'impl', 'match', 'mod', 'crate', 'package', 'defer', 'go', 'chan'
])

export function isNavigableSymbol(word: string, _language?: string): boolean {
  if (!word || word.length < 2) return false
  if (/^\d+$/.test(word)) return false
  if (NON_NAVIGABLE_KEYWORDS.has(word)) return false
  return /^[a-zA-Z_]\w*$/.test(word)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function isCppLanguage(language?: string): boolean {
  return language === 'cpp' || language === 'c'
}

export function isHeaderPath(filePath: string): boolean {
  return /\.(?:h|hh|hpp|hxx|cuh|inl|ipp|tpp)$/i.test(filePath)
}

export function isSourcePath(filePath: string): boolean {
  return /\.(?:c|cc|cpp|cxx|cu)$/i.test(filePath)
}

function stripExt(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot > 0 ? fileName.slice(0, dot) : fileName
}

function baseName(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx >= 0 ? p.slice(idx + 1) : p
}

function dirName(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx > 0 ? p.slice(0, idx) : '/'
}

/**
 * Detects `#include "path/to/header.h"` or `#include <path/to/header.h>` on a C/C++ line.
 */
export function parseCppIncludeAtLine(lineText: string): { target: string; isSystem: boolean; startCol: number; endCol: number } | null {
  const m = /^\s*#\s*include\s*(["<])([^">]+)[">]/.exec(lineText)
  if (!m) return null
  const target = m[2].trim()
  if (!target) return null
  const startIdx = lineText.indexOf(target, m.index)
  return {
    target,
    isSystem: m[1] === '<',
    startCol: startIdx + 1,
    endCol: startIdx + target.length + 1
  }
}

/**
 * Returns ordered candidate file paths for C/C++ Switch Header / Source (`⌥⌘O`).
 */
export function getSiblingHeaderSourceCandidates(filePath: string): string[] {
  const dir = dirName(filePath)
  const name = baseName(filePath)
  const stem = stripExt(name)
  const candidates: string[] = []

  const targetExts = isHeaderPath(name)
    ? ['.cpp', '.cc', '.cxx', '.c', '.cu']
    : isSourcePath(name)
      ? ['.h', '.hpp', '.hh', '.hxx', '.cuh']
      : []

  if (targetExts.length === 0) return []

  // 1. Same directory
  for (const ext of targetExts) {
    candidates.push(`${dir}/${stem}${ext}`)
  }

  // 2. Common C++ repo mirror directories (`src/` ↔ `include/`, `src/` ↔ `inc/`)
  const swapPairs: Array<[RegExp, string]> = [
    [/\/src(\/|$)/, '/include$1'],
    [/\/include(\/|$)/, '/src$1'],
    [/\/inc(\/|$)/, '/src$1'],
    [/\/src(\/|$)/, '/inc$1']
  ]
  for (const [re, rep] of swapPairs) {
    if (re.test(dir)) {
      const mirroredDir = dir.replace(re, rep)
      if (mirroredDir !== dir) {
        for (const ext of targetExts) {
          candidates.push(`${mirroredDir}/${stem}${ext}`)
        }
      }
    }
  }

  return Array.from(new Set(candidates))
}

/**
 * Extracts optional C++ scope/receiver qualifier right before `symbol` at `column` (1-based),
 * e.g. `MyClass::Process` -> `'MyClass'`, `ns::Foo` -> `'ns'`.
 */
export function extractCppQualifier(lineText: string, column: number): string | undefined {
  const prefix = lineText.slice(0, Math.max(0, column - 1))
  const m = /([a-zA-Z_]\w*)\s*::\s*$/.exec(prefix)
  return m?.[1]
}

/**
 * Classifies a matched line as `definition`, `declaration`, `reference`, or `comment`.
 */
export function classifySymbolMatch(
  lineText: string,
  symbol: string,
  language?: string,
  filePath?: string
): SymbolMatchKind {
  const trimmed = lineText.trim()
  if (!trimmed) return 'reference'

  // Comment lines
  if (
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    (trimmed.startsWith('#') && !/^#\s*define\b/.test(trimmed))
  ) {
    return 'comment'
  }

  const sym = escapeRegExp(symbol)
  const inHeader = filePath ? isHeaderPath(filePath) : false

  // Preprocessor `#define SYMBOL`
  if (new RegExp(`^#\\s*define\\s+${sym}\\b`).test(trimmed)) {
    return 'definition'
  }

  // C / C++ type / namespace / alias definitions
  if (
    new RegExp(`^\\s*(?:template\\s*<[^>]*>\\s*)?(?:class|struct|enum(?:\\s+class|\\s+struct)?|union|namespace)\\s+(?:[A-Z0-9_]+\\s+)*${sym}\\b`).test(
      trimmed
    )
  ) {
    // Forward declaration `class Foo;` -> declaration, otherwise definition!
    if (/;\s*(?:\/\/.*)?$/.test(trimmed) && !trimmed.includes('{')) {
      return 'declaration'
    }
    return 'definition'
  }

  // C++ `using Alias = ...` or `typedef ... Alias;`
  if (
    new RegExp(`^\\s*using\\s+${sym}\\s*=`).test(trimmed) ||
    new RegExp(`^\\s*typedef\\b.*\\b${sym}\\s*;`).test(trimmed)
  ) {
    return 'definition'
  }

  // C++ out-of-line method definition: `RetType Class::Method(...)` (not ending with `;`)
  if (
    new RegExp(`\\b[a-zA-Z_]\\w*(?:<[^;{}\\n]*>)?\\s*::\\s*~?${sym}\\s*\\(`).test(trimmed) &&
    !/^(?:return|if|while|for|switch|else|throw)\b/.test(trimmed) &&
    !/[=,(]\s*[a-zA-Z_]\w*::/.test(trimmed.slice(0, Math.max(0, trimmed.indexOf(symbol))))
  ) {
    return /;\s*(?:\/\/.*)?$/.test(trimmed) && !trimmed.includes('{') ? 'declaration' : 'definition'
  }

  // C/C++ function/method definition or header declaration:
  // `RetType [const|*] symbol(...) [const|override|final|noexcept] [{ | ;]`
  if (
    (isCppLanguage(language) || (filePath && (isHeaderPath(filePath) || isSourcePath(filePath)))) &&
    new RegExp(`\\b~?${sym}\\s*\\(`).test(trimmed)
  ) {
    const beforeSym = trimmed.slice(0, trimmed.search(new RegExp(`\\b~?${sym}\\s*\\(`))).trim()
    const isControlOrCall =
      !beforeSym ||
      /^(?:if|else|for|while|switch|return|throw|case|delete|co_await|co_return|else\s+if)\b/.test(beforeSym) ||
      /[=+\-*/%&|^!<>?:,(]\s*$/.test(beforeSym) ||
      /(?:->|\.)\s*$/.test(beforeSym)
    if (!isControlOrCall) {
      // Looks like a return type / storage specifier precedes `symbol(`
      if (trimmed.includes('{') || /\)\s*(?:const|noexcept|override|final|->|\s*$)/.test(trimmed)) {
        if (/;\s*(?:\/\/.*)?$/.test(trimmed) && !trimmed.includes('{')) {
          return inHeader ? 'declaration' : 'declaration'
        }
        return 'definition'
      }
      if (/;\s*(?:\/\/.*)?$/.test(trimmed)) {
        return 'declaration'
      }
    }
  }

  // Python `def symbol(` / `class symbol`
  if (new RegExp(`^(?:async\\s+)?def\\s+${sym}\\s*\\(`).test(trimmed) || new RegExp(`^class\\s+${sym}\\b`).test(trimmed)) {
    return 'definition'
  }

  // Shell `function symbol` or `symbol() {`
  if (
    new RegExp(`^function\\s+${sym}\\b`).test(trimmed) ||
    new RegExp(`^${sym}\\s*\\(\\s*\\)`).test(trimmed)
  ) {
    return 'definition'
  }

  // TS / JS / Go / Rust definitions
  if (
    new RegExp(
      `^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:pub(?:\\([^)]*\\))?\\s+)?(?:function|class|interface|type|enum|const|let|var|func|fn|struct|trait|mod)\\s+(?:\\([^)]*\\)\\s+)?${sym}\\b`
    ).test(trimmed)
  ) {
    return 'definition'
  }

  return 'reference'
}

/**
 * Ranks symbol occurrences so definitions, matching C++ qualifiers (`Class::Method`),
 * sibling header/source pairs, and nearby files consistently rise to the top!
 */
export function rankSymbolMatches(
  rawMatches: Array<{
    envId: string
    filePath: string
    relativePath: string
    line: number
    column: number
    matchLength: number
    lineText: string
  }>,
  opts: {
    symbol: string
    currentFilePath: string
    currentLine?: number
    language?: string
    qualifier?: string
  }
): SymbolOccurrence[] {
  const curDir = dirName(opts.currentFilePath)
  const curStem = stripExt(baseName(opts.currentFilePath)).toLowerCase()
  const curIsTest = /(?:^|[_/.-])(test|tests|mock|mocks|spec)(?:[_/.-]|$)/i.test(opts.currentFilePath)
  const qualRe = opts.qualifier
    ? new RegExp(`\\b${escapeRegExp(opts.qualifier)}(?:<[^;\\n]*>)?\\s*::\\s*~?${escapeRegExp(opts.symbol)}\\b`)
    : null

  return rawMatches
    .map((m) => {
      const kind = classifySymbolMatch(m.lineText, opts.symbol, opts.language, m.filePath)
      let score =
        kind === 'definition'
          ? 1000
          : kind === 'declaration'
            ? 650
            : kind === 'reference'
              ? 200
              : 10

      // Huge boost when explicit C++ qualifier matches (`Foo::Bar`)
      if (qualRe && qualRe.test(m.lineText)) {
        score += 450
      }

      // Same file vs sibling header/source vs same directory
      if (m.filePath === opts.currentFilePath) {
        score += 180
        // Slight penalty if it's the exact line the cursor is already sitting on
        if (opts.currentLine && m.line === opts.currentLine) {
          score -= 350
        }
      } else {
        const mStem = stripExt(baseName(m.filePath)).toLowerCase()
        if (mStem === curStem && (isHeaderPath(m.filePath) || isSourcePath(m.filePath))) {
          score += 260
        } else if (dirName(m.filePath) === curDir) {
          score += 110
        }
      }

      // When jumping from a header declaration, boost `.cpp` implementation above other headers (and vice versa!)
      if (isHeaderPath(opts.currentFilePath) && isSourcePath(m.filePath) && kind === 'definition') {
        score += 120
      } else if (isSourcePath(opts.currentFilePath) && isHeaderPath(m.filePath) && (kind === 'definition' || kind === 'declaration')) {
        score += 60
      }

      // De-prioritize test/mock files when navigating from production code
      if (!curIsTest && /(?:^|[_/.-])(test|tests|mock|mocks|spec)(?:[_/.-]|$)/i.test(m.filePath)) {
        score -= 90
      }

      return { ...m, kind, score }
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (a.relativePath !== b.relativePath) return a.relativePath.localeCompare(b.relativePath)
      return a.line - b.line
    })
}

/**
 * Scans the current file synchronously (0ms) for all whole-word occurrences of `symbol`.
 */
export function findInFileOccurrences(
  content: string,
  symbol: string,
  meta: { envId: string; filePath: string; relativePath: string; language?: string }
): SymbolOccurrence[] {
  if (!content || !symbol) return []
  const re = new RegExp(`\\b${escapeRegExp(symbol)}\\b`, 'g')
  const lines = content.split(/\r?\n/)
  const out: SymbolOccurrence[] = []

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i]
    if (!lineText.includes(symbol)) continue
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(lineText)) !== null) {
      const kind = classifySymbolMatch(lineText, symbol, meta.language, meta.filePath)
      out.push({
        envId: meta.envId,
        filePath: meta.filePath,
        relativePath: meta.relativePath,
        line: i + 1,
        column: m.index + 1,
        matchLength: symbol.length,
        lineText,
        kind,
        score: kind === 'definition' ? 1000 : kind === 'declaration' ? 650 : kind === 'reference' ? 200 : 10
      })
      if (out.length >= 250) return out
    }
  }
  return out
}

/**
 * Lightweight regex-based document symbol outline extractor for `⌘⇧O` / `⌘R` Goto Symbol in File.
 */
export function extractDocumentSymbols(content: string, language: string): DocumentSymbolEntry[] {
  if (!content) return []
  const lines = content.split(/\r?\n/)
  const symbols: DocumentSymbolEntry[] = []
  const seen = new Set<string>()

  const push = (entry: DocumentSymbolEntry) => {
    const key = `${entry.line}:${entry.name}`
    if (seen.has(key)) return
    seen.add(key)
    symbols.push(entry)
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue

    const lineNum = i + 1

    if (language === 'cpp' || language === 'c') {
      // #define MACRO
      let m = /^#\s*define\s+([A-Za-z_]\w*)/.exec(trimmed)
      if (m) {
        const col = line.indexOf(m[1]) + 1
        push({ name: m[1], kind: 'macro', detail: '#define', line: lineNum, column: col, endColumn: col + m[1].length })
        continue
      }

      // namespace Foo
      m = /^namespace\s+([A-Za-z_][\w:]*)\s*\{?/.exec(trimmed)
      if (m && !trimmed.endsWith(';')) {
        const col = line.indexOf(m[1]) + 1
        push({ name: m[1], kind: 'namespace', detail: 'namespace', line: lineNum, column: col, endColumn: col + m[1].length })
        continue
      }

      // class / struct / enum / union (skip forward declarations ending with `;`)
      m = /^(?:template\s*<[^>]*>\s*)?(class|struct|enum(?:\s+class|\s+struct)?|union)\s+(?:[A-Z0-9_]+\s+)*([A-Za-z_]\w*)/.exec(trimmed)
      if (m && !(trimmed.endsWith(';') && !trimmed.includes('{'))) {
        const kw = m[1].startsWith('enum') ? 'enum' : m[1] === 'class' ? 'class' : 'struct'
        const col = line.indexOf(m[2]) + 1
        push({ name: m[2], kind: kw, detail: m[1], line: lineNum, column: col, endColumn: col + m[2].length })
        continue
      }

      // using Alias = ...
      m = /^using\s+([A-Za-z_]\w*)\s*=/.exec(trimmed)
      if (m) {
        const col = line.indexOf(m[1]) + 1
        push({ name: m[1], kind: 'type', detail: 'using', line: lineNum, column: col, endColumn: col + m[1].length })
        continue
      }

      // Out-of-line C++ method: `RetType Class::Method(...)`
      m = /\b([A-Za-z_]\w*(?:<[^;{}\n]*>)?)::([~A-Za-z_]\w*)\s*\(/.exec(trimmed)
      if (m && !/^(?:if|for|while|switch|return|throw|else)\b/.test(trimmed) && !/[=,(]\s*[A-Za-z_]\w*::/.test(trimmed.slice(0, m.index))) {
        const fullName = `${m[1]}::${m[2]}`
        const col = line.indexOf(m[2], Math.max(0, line.indexOf(m[1]))) + 1
        push({ name: fullName, kind: 'method', detail: 'method', line: lineNum, column: col, endColumn: col + m[2].length })
        continue
      }

      // Free/member function definition: `RetType funcName(...) {` (or trailing const/override/noexcept)
      m = /^(?:(?:static|inline|virtual|constexpr|consteval|explicit|extern|friend|__global__|__device__|__host__)\s+)*(?:const\s+)?[A-Za-z_][\w:<>,*\s&]*?\s+([~A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:final\s*)?(?:\{|$)/.exec(
        trimmed
      )
      if (m && !NON_NAVIGABLE_KEYWORDS.has(m[1]) && !trimmed.endsWith(';')) {
        const col = line.indexOf(m[1]) + 1
        push({ name: m[1], kind: 'function', detail: 'function', line: lineNum, column: col, endColumn: col + m[1].length })
      }
      continue
    }

    if (language === 'python') {
      let m = /^class\s+([A-Za-z_]\w*)/.exec(trimmed)
      if (m) {
        const col = line.indexOf(m[1]) + 1
        push({ name: m[1], kind: 'class', detail: 'class', line: lineNum, column: col, endColumn: col + m[1].length })
        continue
      }
      m = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(trimmed)
      if (m) {
        const col = line.indexOf(m[1]) + 1
        const isMethod = /^\s+/.test(line)
        push({ name: m[1], kind: isMethod ? 'method' : 'function', detail: isMethod ? 'method' : 'def', line: lineNum, column: col, endColumn: col + m[1].length })
      }
      continue
    }

    if (language === 'shell') {
      if (trimmed.startsWith('#')) continue
      let m = /^function\s+([A-Za-z_]\w*)/.exec(trimmed)
      if (!m) m = /^([A-Za-z_]\w*)\s*\(\s*\)/.exec(trimmed)
      if (m) {
        const col = line.indexOf(m[1]) + 1
        push({ name: m[1], kind: 'function', detail: 'shell fn', line: lineNum, column: col, endColumn: col + m[1].length })
      }
      continue
    }

    if (language === 'typescript' || language === 'javascript' || language === 'go' || language === 'rust') {
      const m =
        /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:pub(?:\([^)]*\))?\s+)?(class|interface|type|enum|function|func|fn|struct|trait)\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)/.exec(
          trimmed
        )
      if (m) {
        const rawKind = m[1]
        const kind =
          rawKind === 'class'
            ? 'class'
            : rawKind === 'struct' || rawKind === 'interface' || rawKind === 'trait'
              ? 'struct'
              : rawKind === 'enum'
                ? 'enum'
                : rawKind === 'type'
                  ? 'type'
                  : 'function'
        const col = line.indexOf(m[2]) + 1
        push({ name: m[2], kind, detail: rawKind, line: lineNum, column: col, endColumn: col + m[2].length })
      }
    }
  }

  return symbols
}
