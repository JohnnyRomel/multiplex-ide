import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { Environment, QuickOpenFile, SearchDoneEvent, SearchMatch, SearchRequest } from '@shared/types'
import type { SshControlMaster } from '../ssh/controlMaster'

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const DEFAULT_EXCLUDE_DIRS = [
  '.git',
  'node_modules',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  'Library',
  'Applications',
  'Movies',
  'Music',
  'Pictures',
  '.Trash'
]

const REMOTE_PATH_EXPORT =
  'export PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH";'

function findRgLocalBinary(): string | null {
  const candidates = ['/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg']
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      // ignore
    }
  }
  return null
}

/**
 * Splits a Goto-Anything file query into clean search tokens.
 * Example: "feature_handler.cpp" -> ["feature_handler.cpp"]
 * Example: "service handler cpp" -> ["service", "handler", "cpp"]
 */
export function splitFileQueryTokens(rawQuery: string): string[] {
  return rawQuery
    .trim()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
}

/**
 * Builds a POSIX shell pipeline suffix (`| grep -iF -- 'tok1' | grep -iF -- 'tok2' | head -n LIMIT`)
 * so filtering happens directly on the remote/local host across 100% of files before `head` truncation!
 */
function buildShellTokenFilterPipeline(tokens: string[], limit: number): string {
  if (tokens.length === 0) {
    return `| head -n ${limit}`
  }
  const greps = tokens.map((tok) => `grep -iF -- ${shellQuote(tok)}`).join(' | ')
  return `| ${greps} | head -n ${limit}`
}

/**
 * Builds a subsequence fallback regex for abbreviations like "tmfh.cpp" -> "t.*m.*f.*h.*\.cpp"
 */
function buildSubsequenceRegex(query: string): string {
  const compact = query.replace(/\s+/g, '')
  return Array.from(compact)
    .map((ch) => ch.replace(/[.+^${}()|[\]\\*?]/g, '\\$&'))
    .join('.*')
}

export function scoreQuickOpenCandidate(file: QuickOpenFile, rawQuery: string): number {
  const q = rawQuery.trim().toLowerCase()
  if (!q) return 1

  const nameLower = file.name.toLowerCase()
  const relLower = file.relativePath.toLowerCase()
  const tokens = splitFileQueryTokens(q)

  // Tier 1: Exact filename match ("feature_handler.cpp" === "feature_handler.cpp")
  if (nameLower === q) return 10000 - file.relativePath.length * 0.05

  // Tier 2: Filename ends with query ("my_service_feature_handler.cpp" ends with "feature_handler.cpp"!)
  if (nameLower.endsWith(q)) {
    const idx = nameLower.length - q.length
    const boundaryBonus = idx === 0 || '_-.'.includes(nameLower[idx - 1]) ? 400 : 0
    return 8500 + boundaryBonus - file.name.length * 2 - file.relativePath.length * 0.05
  }

  // Tier 3: Filename starts with query
  if (nameLower.startsWith(q)) {
    return 7800 - file.name.length * 2 - file.relativePath.length * 0.05
  }

  // Tier 4: Filename contains contiguous query ("my_service_feature_handler.cpp" includes "service_feature")
  const nameIdx = nameLower.indexOf(q)
  if (nameIdx >= 0) {
    const boundaryBonus = nameIdx === 0 || '_-.'.includes(nameLower[nameIdx - 1]) ? 300 : 0
    return 7000 + boundaryBonus - nameIdx * 3 - file.name.length * 1.5
  }

  // Tier 5: Full relative path contains contiguous query (e.g. "service/my_feature_handler.cpp")
  const relIdx = relLower.indexOf(q)
  if (relIdx >= 0) {
    return 5500 - file.relativePath.length * 0.5
  }

  // Tier 6: Multi-token match where ALL tokens appear in filename ("service handler" -> "my_service_feature_handler.cpp")
  if (tokens.length > 1 && tokens.every((t) => nameLower.includes(t))) {
    return 4800 - file.name.length * 2
  }

  // Tier 7: Multi-token match across relative path
  if (tokens.length > 1 && tokens.every((t) => relLower.includes(t))) {
    return 3600 - file.relativePath.length * 0.5
  }

  // Tier 8: Fuzzy character subsequence in filename FIRST (avoids greedy path mismatch!)
  const compact = q.replace(/\s+/g, '')
  let ni = 0
  let nameScore = 0
  let streak = 0
  let matchedAllInName = true
  for (let i = 0; i < compact.length; i++) {
    const found = nameLower.indexOf(compact[i], ni)
    if (found < 0) {
      matchedAllInName = false
      break
    }
    streak = found === ni ? streak + 5 : 0
    const boundary = found === 0 || '_-.'.includes(nameLower[found - 1]) ? 8 : 0
    nameScore += 2 + streak + boundary
    ni = found + 1
  }
  if (matchedAllInName) {
    return 1800 + nameScore - file.name.length
  }

  // Tier 9: Fuzzy character subsequence in full relativePath
  let pi = 0
  let pathScore = 0
  streak = 0
  for (let i = 0; i < compact.length; i++) {
    const found = relLower.indexOf(compact[i], pi)
    if (found < 0) return -1
    streak = found === pi ? streak + 3 : 0
    const boundary = found === 0 || '/_-.'.includes(relLower[found - 1]) ? 5 : 0
    pathScore += 1 + streak + boundary
    pi = found + 1
  }
  return 400 + pathScore - file.relativePath.length * 0.2
}

export function parseRgJsonLine(
  line: string,
  searchId: string,
  envId: string,
  rootPath: string
): SearchMatch[] {
  if (!line.trim()) return []
  try {
    const msg = JSON.parse(line)
    if (msg.type !== 'match') return []
    const rawPath: string = msg.data?.path?.text || ''
    if (!rawPath) return []
    const cleanRoot = rootPath.replace(/\/+$/, '')
    const filePath = path.posix.isAbsolute(rawPath) ? rawPath : path.posix.join(cleanRoot || '/', rawPath)
    const relativePath = filePath.startsWith(cleanRoot + '/') ? filePath.slice(cleanRoot.length + 1) : rawPath
    const lineNum: number = msg.data?.line_number ?? 1
    const lineText: string = (msg.data?.lines?.text ?? '').replace(/\r?\n$/, '')
    const submatches: Array<{ start: number; end: number }> = msg.data?.submatches ?? []

    if (submatches.length === 0) {
      return [
        {
          searchId,
          envId,
          filePath,
          relativePath,
          line: lineNum,
          column: 1,
          matchLength: 1,
          lineText
        }
      ]
    }

    return submatches.map((sm) => ({
      searchId,
      envId,
      filePath,
      relativePath,
      line: lineNum,
      column: (sm.start ?? 0) + 1,
      matchLength: Math.max(1, (sm.end ?? 0) - (sm.start ?? 0)),
      lineText
    }))
  } catch {
    return []
  }
}

export function parseGrepLine(
  line: string,
  searchId: string,
  envId: string,
  rootPath: string,
  query: string,
  opts?: { isRegex?: boolean; isCaseSensitive?: boolean }
): SearchMatch | null {
  const firstColon = line.indexOf(':')
  if (firstColon <= 0) return null
  const secondColon = line.indexOf(':', firstColon + 1)
  if (secondColon <= firstColon + 1) return null

  const rawPath = line.slice(0, firstColon)
  const lineNum = parseInt(line.slice(firstColon + 1, secondColon), 10)
  if (!Number.isFinite(lineNum)) return null
  const lineText = line.slice(secondColon + 1).replace(/\r?\n$/, '')
  const cleanRoot = rootPath.replace(/\/+$/, '')
  const filePath = path.posix.isAbsolute(rawPath) ? rawPath : path.posix.join(cleanRoot || '/', rawPath)
  const relativePath = filePath.startsWith(cleanRoot + '/') ? filePath.slice(cleanRoot.length + 1) : rawPath

  let column = 1
  let matchLength = Math.max(1, query.length)
  if (query) {
    try {
      if (opts?.isRegex) {
        const re = new RegExp(query, opts.isCaseSensitive ? '' : 'i')
        const m = re.exec(lineText)
        if (m && m.index >= 0) {
          column = m.index + 1
          matchLength = Math.max(1, m[0].length)
        }
      } else {
        const hay = opts?.isCaseSensitive ? lineText : lineText.toLowerCase()
        const needle = opts?.isCaseSensitive ? query : query.toLowerCase()
        const idx = hay.indexOf(needle)
        if (idx >= 0) {
          column = idx + 1
          matchLength = needle.length
        }
      }
    } catch {
      // fallback column 1
    }
  }

  return {
    searchId,
    envId,
    filePath,
    relativePath,
    line: lineNum,
    column,
    matchLength,
    lineText
  }
}

export class SearchManager {
  private activeProcs = new Map<string, Set<ChildProcess>>()
  private activeFileQueries = new Map<string, Set<ChildProcess>>()

  constructor(
    private controlMaster: SshControlMaster,
    private events: {
      onMatchBatch: (matches: SearchMatch[]) => void
      onDone: (done: SearchDoneEvent) => void
      onSshConnected?: (envId: string) => void
    }
  ) {}

  cancel(searchId: string): void {
    const set = this.activeProcs.get(searchId)
    if (!set) return
    for (const p of set) {
      try {
        p.kill('SIGTERM')
      } catch {
        // ignore
      }
    }
    this.activeProcs.delete(searchId)
  }

  cancelFileQuery(requestId: string): void {
    const set = this.activeFileQueries.get(requestId)
    if (!set) return
    for (const p of set) {
      try {
        p.kill('SIGTERM')
      } catch {
        // ignore
      }
    }
    this.activeFileQueries.delete(requestId)
  }

  async startSearch(req: SearchRequest, envLookup: (envId: string) => Environment | undefined): Promise<void> {
    const startedAt = Date.now()
    const maxResults = req.maxResults ?? 1500
    const procs = new Set<ChildProcess>()
    this.activeProcs.set(req.searchId, procs)

    let totalMatches = 0
    let truncated = false
    const errors: Array<{ envId: string; message: string }> = []
    let batch: SearchMatch[] = []

    const flush = () => {
      if (batch.length > 0) {
        this.events.onMatchBatch(batch)
        batch = []
      }
    }

    const flushTimer = setInterval(flush, 40)

    const pushMatches = (items: SearchMatch[]) => {
      for (const m of items) {
        if (totalMatches >= maxResults) {
          truncated = true
          this.cancel(req.searchId)
          break
        }
        totalMatches++
        batch.push(m)
        if (batch.length >= 50) flush()
      }
    }

    await Promise.all(
      req.targets.map(async (target) => {
        const env = envLookup(target.envId)
        if (!env) return
        try {
          if (env.kind === 'ssh') {
            const ok = await this.controlMaster.ensureConnected(env)
            if (!ok) {
              errors.push({
                envId: env.id,
                message: `SSH not connected to ${env.name} (authenticate in terminal first if needed)`
              })
              return
            }
            this.events.onSshConnected?.(env.id)
          }
          const rootPath = await this.controlMaster.normalizePath(env, target.rootPath)
          await this.searchSingleEnv(env, rootPath, req, procs, pushMatches)
        } catch (err: any) {
          errors.push({ envId: target.envId, message: err?.message || String(err) })
        }
      })
    )

    clearInterval(flushTimer)
    flush()
    this.activeProcs.delete(req.searchId)

    this.events.onDone({
      searchId: req.searchId,
      totalMatches,
      truncated,
      errors,
      durationMs: Date.now() - startedAt
    })
  }

  private buildRgArgs(req: SearchRequest, rootPath: string): string[] {
    // Include -L (--follow) so symlinked workspaces (e.g. ~/workspace -> /data/...) are searched!
    const args = [
      '-L',
      '--json',
      '--line-number',
      '--column',
      '--no-heading',
      '--max-filesize',
      '2M',
      '--max-columns',
      '500',
      '--max-depth',
      '16'
    ]
    if (!req.isRegex) args.push('--fixed-strings')
    if (req.isCaseSensitive) args.push('--case-sensitive')
    else args.push('--ignore-case')
    if (req.wholeWord) args.push('--word-regexp')

    for (const dir of DEFAULT_EXCLUDE_DIRS) {
      args.push('--glob', `!**/${dir}/**`)
    }
    if (req.excludeGlob) {
      for (const ex of req.excludeGlob.split(',')) {
        const trimmed = ex.trim()
        if (trimmed) args.push('--glob', `!${trimmed}`)
      }
    }
    if (req.includeGlob) {
      for (const inc of req.includeGlob.split(',')) {
        const trimmed = inc.trim()
        if (trimmed) args.push('--glob', trimmed)
      }
    }

    args.push('--', req.query, rootPath)
    return args
  }

  private async searchSingleEnv(
    env: Environment,
    rootPath: string,
    req: SearchRequest,
    procs: Set<ChildProcess>,
    onMatches: (matches: SearchMatch[]) => void
  ): Promise<void> {
    if (env.kind === 'local') {
      if (!fs.existsSync(rootPath)) {
        throw new Error(`Directory does not exist: ${rootPath}`)
      }
      const rgBin = findRgLocalBinary()
      const args = this.buildRgArgs(req, rootPath)
      if (rgBin) {
        const ok = await this.runRgProcess(
          () => spawn(rgBin, args, { stdio: ['ignore', 'pipe', 'pipe'] }),
          req.searchId,
          env.id,
          rootPath,
          procs,
          onMatches
        )
        if (ok) return
      }
      await this.runGrepFallbackLocal(rootPath, req, procs, onMatches)
      return
    }

    const rgArgs = this.buildRgArgs(req, rootPath).map(shellQuote).join(' ')
    const grepExcludes = DEFAULT_EXCLUDE_DIRS.map((d) => `--exclude-dir=${shellQuote(d)}`).join(' ')
    const grepFlags = ['-rnI', grepExcludes]
    if (!req.isRegex) grepFlags.push('-F')
    if (!req.isCaseSensitive) grepFlags.push('-i')
    if (req.wholeWord) grepFlags.push('-w')

    const remoteScript = `${REMOTE_PATH_EXPORT} if [ ! -d ${shellQuote(rootPath)} ]; then echo "Directory not found: ${rootPath}" >&2; exit 2; fi; if command -v rg >/dev/null 2>&1; then printf '__MODE__:rg\\n'; rg ${rgArgs}; else printf '__MODE__:grep\\n'; grep ${grepFlags.join(' ')} -- ${shellQuote(req.query)} ${shellQuote(rootPath)} | head -n 1500; fi`

    await new Promise<void>((resolve, reject) => {
      const child = this.controlMaster.spawnRemoteCommand(env, remoteScript)
      procs.add(child)
      let mode: 'rg' | 'grep' = 'rg'
      let buf = ''
      let stderr = ''

      const processLine = (line: string) => {
        if (line === '__MODE__:rg') {
          mode = 'rg'
          return
        }
        if (line === '__MODE__:grep') {
          mode = 'grep'
          return
        }
        if (mode === 'rg') {
          const parsed = parseRgJsonLine(line, req.searchId, env.id, rootPath)
          if (parsed.length > 0) onMatches(parsed)
        } else {
          const parsed = parseGrepLine(line, req.searchId, env.id, rootPath, req.query, {
            isRegex: req.isRegex,
            isCaseSensitive: req.isCaseSensitive
          })
          if (parsed) onMatches([parsed])
        }
      }

      child.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        let idx: number
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 1)
          processLine(line)
        }
      })

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      child.on('error', (err) => {
        procs.delete(child)
        reject(err)
      })

      child.on('close', (code) => {
        if (buf.trim()) processLine(buf)
        procs.delete(child)
        if (code === 0 || code === 1 || code === null) {
          resolve()
        } else if (stderr.trim()) {
          reject(new Error(stderr.trim()))
        } else {
          resolve()
        }
      })
    })
  }

  private runRgProcess(
    factory: () => ChildProcess,
    searchId: string,
    envId: string,
    rootPath: string,
    procs: Set<ChildProcess>,
    onMatches: (matches: SearchMatch[]) => void
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let child: ChildProcess
      try {
        child = factory()
      } catch {
        resolve(false)
        return
      }
      procs.add(child)
      let buf = ''
      let spawnFailed = false

      child.stdout?.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        let idx: number
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 1)
          const parsed = parseRgJsonLine(line, searchId, envId, rootPath)
          if (parsed.length > 0) onMatches(parsed)
        }
      })

      child.on('error', () => {
        spawnFailed = true
        procs.delete(child)
        resolve(false)
      })

      child.on('close', (code) => {
        if (buf.trim()) {
          const parsed = parseRgJsonLine(buf, searchId, envId, rootPath)
          if (parsed.length > 0) onMatches(parsed)
        }
        procs.delete(child)
        if (spawnFailed) return
        resolve(code !== 127)
      })
    })
  }

  private runGrepFallbackLocal(
    rootPath: string,
    req: SearchRequest,
    procs: Set<ChildProcess>,
    onMatches: (matches: SearchMatch[]) => void
  ): Promise<void> {
    return new Promise((resolve) => {
      const args = ['-rnI', ...DEFAULT_EXCLUDE_DIRS.map((d) => `--exclude-dir=${d}`)]
      if (!req.isRegex) args.push('-F')
      if (!req.isCaseSensitive) args.push('-i')
      if (req.wholeWord) args.push('-w')
      args.push('--', req.query, rootPath)

      const child = spawn('/usr/bin/grep', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      procs.add(child)
      let buf = ''
      child.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        let idx: number
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 1)
          const parsed = parseGrepLine(line, req.searchId, 'local', rootPath, req.query, {
            isRegex: req.isRegex,
            isCaseSensitive: req.isCaseSensitive
          })
          if (parsed) onMatches([parsed])
        }
      })
      child.on('close', () => {
        procs.delete(child)
        resolve()
      })
      child.on('error', () => {
        procs.delete(child)
        resolve()
      })
    })
  }

  /**
   * Server-side query-aware file finder for Sublime `Cmd+P` Goto Anything!
   * - Follows symlinks (`-L`) so symlinked workspaces (`~/workspace -> /data/...`) work 100%!
   * - Runs `rg --files -L` + server-side `grep -iF` BEFORE `head`,
   *   so even in a 500,000-file C++ monorepo at depth 15, searching `feature_handler.cpp` finds
   *   `my_service_feature_handler.cpp` immediately without premature truncation!
   */
  async searchFiles(
    env: Environment,
    rawRootPath: string,
    query: string,
    opts?: { requestId?: string; limit?: number }
  ): Promise<QuickOpenFile[]> {
    const limit = opts?.limit ?? (query.trim() ? 250 : 400)
    const requestId = opts?.requestId

    if (env.kind === 'ssh') {
      const connected = await this.controlMaster.ensureConnected(env)
      if (!connected) return []
      this.events.onSshConnected?.(env.id)
    }

    const rootPath = await this.controlMaster.normalizePath(env, rawRootPath)
    const cleanRoot = rootPath.replace(/\/+$/, '')
    const tokens = splitFileQueryTokens(query)
    const procSet = new Set<ChildProcess>()
    if (requestId) {
      this.activeFileQueries.set(requestId, procSet)
    }

    const toQuickFile = (raw: string): QuickOpenFile | null => {
      const line = raw.trim()
      if (!line) return null
      const filePath = path.posix.isAbsolute(line) ? line : path.posix.join(cleanRoot || '/', line)
      const relativePath = filePath.startsWith(cleanRoot + '/') ? filePath.slice(cleanRoot.length + 1) : line
      return {
        envId: env.id,
        filePath,
        relativePath,
        name: path.posix.basename(filePath)
      }
    }

    const rgGlobs = DEFAULT_EXCLUDE_DIRS.map((d) => `--glob '!**/${d}/**'`).join(' ')
    const rgBinArtifactGlobs = `--glob '!**/*.o' --glob '!**/*.so' --glob '!**/*.a' --glob '!**/*.pyc'`
    const findPrunes = DEFAULT_EXCLUDE_DIRS.map((d) => `-name ${shellQuote(d)}`).join(' -o ')
    const filterPipe = buildShellTokenFilterPipeline(tokens, limit)

    // 1. Primary generator: follows symlinks (-L, e.g. ~/workspace -> /data/...), up to depth 20
    // 2. Fallback generator (--no-ignore-vcs): catches gitignored / generated / submodule files if primary returns empty!
    // 3. Subsequence fallback: catches compact abbreviations like "tmfh.cpp"
    const subseqRegex = tokens.length > 0 && query.trim().length <= 32 ? buildSubsequenceRegex(query) : ''
    const listGenerator = `if command -v rg >/dev/null 2>&1; then rg --files -L --hidden --max-depth 20 ${rgGlobs} ${shellQuote(rootPath)} 2>/dev/null; else find -L ${shellQuote(rootPath)} -maxdepth 16 \\( ${findPrunes} \\) -prune -o -type f -print 2>/dev/null; fi`
    const listNoIgnoreGenerator = `if command -v rg >/dev/null 2>&1; then rg --files -L --hidden --no-ignore-vcs --max-depth 20 ${rgGlobs} ${rgBinArtifactGlobs} ${shellQuote(rootPath)} 2>/dev/null; fi`

    const fullScript =
      tokens.length === 0
        ? `${REMOTE_PATH_EXPORT} if [ ! -d ${shellQuote(rootPath)} ]; then exit 0; fi; ( ${listGenerator} ) | head -n ${limit}`
        : `${REMOTE_PATH_EXPORT} if [ ! -d ${shellQuote(rootPath)} ]; then exit 0; fi; OUT=$(( ${listGenerator} ) ${filterPipe}); if [ -z "$OUT" ]; then OUT=$(( ${listNoIgnoreGenerator} ) ${filterPipe}); fi; if [ -n "$OUT" ]; then printf '%s\\n' "$OUT"; elif [ -n ${shellQuote(subseqRegex)} ]; then ( ${listGenerator} ) | grep -iE -- ${shellQuote(subseqRegex)} | head -n ${limit}; fi`

    try {
      const lines = await new Promise<string[]>((resolve) => {
        const child =
          env.kind === 'local'
            ? spawn('/bin/zsh', ['-c', fullScript], { stdio: ['ignore', 'pipe', 'ignore'] })
            : this.controlMaster.spawnRemoteCommand(env, fullScript)

        procSet.add(child)
        let stdout = ''
        const timer = setTimeout(() => {
          try {
            child.kill('SIGTERM')
          } catch {
            // ignore
          }
          resolve(stdout.split('\n'))
        }, 8000)

        child.stdout.on('data', (chunk: Buffer) => {
          if (stdout.length < 2 * 1024 * 1024) {
            stdout += chunk.toString('utf8')
          }
        })
        child.on('error', () => {
          clearTimeout(timer)
          procSet.delete(child)
          resolve([])
        })
        child.on('close', () => {
          clearTimeout(timer)
          procSet.delete(child)
          resolve(stdout.split('\n'))
        })
      })

      const candidates: QuickOpenFile[] = []
      for (const line of lines) {
        const item = toQuickFile(line)
        if (item) candidates.push(item)
      }

      if (!query.trim()) return candidates.slice(0, limit)

      return candidates
        .map((f) => ({ file: f, score: scoreQuickOpenCandidate(f, query) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((x) => x.file)
    } finally {
      if (requestId) {
        this.activeFileQueries.delete(requestId)
      }
    }
  }

  async listFiles(env: Environment, rawRootPath: string, limit = 400): Promise<QuickOpenFile[]> {
    return this.searchFiles(env, rawRootPath, '', { limit })
  }
}
