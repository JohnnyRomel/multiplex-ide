import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { execFile } from 'child_process'
import type { Readable, Writable } from 'stream'
import type { Environment, FileEntry, FileReadResult, GitStatusEntry } from '@shared/types'
import type { SshControlMaster } from '../ssh/controlMaster'
import { OpenSshSftpPool } from './sftpClient'

function isLikelyBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192)
  let suspicious = 0
  for (let i = 0; i < len; i++) {
    const b = buf[i]
    if (b === 0) return true
    if (b < 7 || (b > 14 && b < 32)) suspicious++
  }
  return len > 0 && suspicious / len > 0.3
}

function formatMode(mode: number): string {
  const perms = mode & 0o777
  const chars = ['r', 'w', 'x']
  let out = ''
  for (let i = 8; i >= 0; i--) {
    out += (perms & (1 << i)) ? chars[(8 - i) % 3] : '-'
  }
  return out
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Decodes text bytes strictly as UTF-8. Non-UTF-8 files (GBK/GB18030, Latin-1, ...) are decoded for
 * display but flagged read-only: the editor saves UTF-8, so writing them back would irreversibly
 * replace every non-ASCII byte. A UTF-8 BOM is preserved as U+FEFF so it round-trips on save.
 */
export function decodeTextBuffer(buf: Buffer): { content: string; readOnly?: boolean; encoding?: string } {
  try {
    return { content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf) }
  } catch {
    // not valid UTF-8
  }
  try {
    return { content: new TextDecoder('gb18030', { fatal: true }).decode(buf), readOnly: true, encoding: 'GB18030' }
  } catch {
    return { content: new TextDecoder('windows-1252').decode(buf), readOnly: true, encoding: 'Latin-1' }
  }
}

export class UnifiedVfs {
  public readonly sftpPool: OpenSshSftpPool

  constructor(private controlMaster: SshControlMaster) {
    this.sftpPool = new OpenSshSftpPool(controlMaster)
  }

  async normalizePath(env: Environment, rawPath: string): Promise<string> {
    return this.controlMaster.normalizePath(env, rawPath)
  }

  async stat(env: Environment, rawPath: string): Promise<FileEntry> {
    const targetPath = await this.normalizePath(env, rawPath)
    if (env.kind === 'local') {
      const lstat = await fsp.lstat(targetPath)
      const isSymlink = lstat.isSymbolicLink()
      let st = lstat
      if (isSymlink) {
        try {
          st = await fsp.stat(targetPath)
        } catch {
          // broken symlink
        }
      }
      return {
        name: path.basename(targetPath) || targetPath,
        path: targetPath,
        envId: env.id,
        isDirectory: st.isDirectory(),
        isSymlink,
        size: st.size,
        mtimeMs: st.mtimeMs,
        permissions: formatMode(st.mode)
      }
    }

    const lstat = await this.sftpPool.lstat(env, targetPath)
    const isSymlink = lstat.isSymbolicLink()
    let st = lstat
    if (isSymlink) {
      try {
        st = await this.sftpPool.stat(env, targetPath)
      } catch {
        // broken symlink
      }
    }
    return {
      name: path.posix.basename(targetPath) || targetPath,
      path: targetPath,
      envId: env.id,
      isDirectory: st.isDirectory(),
      isSymlink,
      size: st.size,
      mtimeMs: st.mtime * 1000,
      permissions: formatMode(st.mode)
    }
  }

  async readDir(env: Environment, rawDir: string): Promise<FileEntry[]> {
    const dir = await this.normalizePath(env, rawDir)
    if (env.kind === 'local') {
      const dirents = await fsp.readdir(dir, { withFileTypes: true })
      const entries: FileEntry[] = []
      await Promise.all(
        dirents.map(async (d) => {
          const full = path.join(dir, d.name)
          try {
            const isSymlink = d.isSymbolicLink()
            let st: fs.Stats
            try {
              st = await fsp.stat(full)
            } catch {
              st = await fsp.lstat(full)
            }
            entries.push({
              name: d.name,
              path: full,
              envId: env.id,
              isDirectory: st.isDirectory(),
              isSymlink,
              size: st.size,
              mtimeMs: st.mtimeMs,
              permissions: formatMode(st.mode)
            })
          } catch {
            // Skip unreadable system entries
          }
        })
      )
      return entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      })
    }

    return this.sftpPool.readdir(env, dir)
  }

  async readFile(env: Environment, rawPath: string): Promise<FileReadResult> {
    const targetPath = await this.normalizePath(env, rawPath)
    const MAX_PREVIEW_BYTES = 8 * 1024 * 1024

    if (env.kind === 'local') {
      const st = await fsp.stat(targetPath)
      if (st.size > MAX_PREVIEW_BYTES) {
        throw new Error(`File is too large (${(st.size / 1024 / 1024).toFixed(1)} MB) to open in editor.`)
      }
      const buf = await fsp.readFile(targetPath)
      const binary = isLikelyBinary(buf)
      const decoded = binary ? { content: '' } : decodeTextBuffer(buf)
      return {
        envId: env.id,
        path: targetPath,
        content: decoded.content,
        size: st.size,
        isBinary: binary,
        readOnly: decoded.readOnly,
        encoding: decoded.encoding,
        mtimeMs: st.mtimeMs
      }
    }

    const st = await this.sftpPool.stat(env, targetPath)
    const buf = await this.sftpPool.readFileBuffer(env, targetPath, MAX_PREVIEW_BYTES)
    const binary = isLikelyBinary(buf)
    const decoded = binary ? { content: '' } : decodeTextBuffer(buf)
    return {
      envId: env.id,
      path: targetPath,
      content: decoded.content,
      size: st.size,
      isBinary: binary,
      readOnly: decoded.readOnly,
      encoding: decoded.encoding,
      mtimeMs: st.mtime * 1000
    }
  }

  async writeFile(env: Environment, rawPath: string, content: string): Promise<void> {
    const targetPath = await this.normalizePath(env, rawPath)
    const buf = Buffer.from(content, 'utf8')
    if (env.kind === 'local') {
      await fsp.mkdir(path.dirname(targetPath), { recursive: true })
      await fsp.writeFile(targetPath, buf)
      return
    }
    // Remote: write a temp file then atomically rename over the original, so a connection drop
    // mid-save can never leave the real file truncated.
    await this.sftpPool.atomicWriteFileBuffer(env, targetPath, buf)
  }

  async mkdir(env: Environment, rawDir: string): Promise<void> {
    const targetDir = await this.normalizePath(env, rawDir)
    if (env.kind === 'local') {
      await fsp.mkdir(targetDir, { recursive: true })
      return
    }
    await this.sftpPool.mkdirRecursive(env, targetDir)
  }

  async createFile(env: Environment, rawPath: string): Promise<void> {
    await this.writeFile(env, rawPath, '')
  }

  async rename(env: Environment, rawOldPath: string, rawNewPath: string): Promise<void> {
    const oldPath = await this.normalizePath(env, rawOldPath)
    const newPath = await this.normalizePath(env, rawNewPath)
    if (oldPath === newPath) return
    if (env.kind === 'local') {
      // fs.rename silently replaces an existing destination — refuse instead of destroying user data
      // (allow case-only renames on case-insensitive APFS, where both paths resolve to the same inode)
      try {
        const [a, b] = await Promise.all([fsp.lstat(oldPath), fsp.lstat(newPath)])
        if (!(a.ino === b.ino && a.dev === b.dev)) {
          throw Object.assign(new Error(`"${path.basename(newPath)}" already exists`), { code: 'EEXIST' })
        }
      } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err
      }
      await fsp.rename(oldPath, newPath)
      return
    }
    try {
      await this.sftpPool.lstat(env, newPath)
      throw Object.assign(new Error(`"${path.posix.basename(newPath)}" already exists`), { code: 'EEXIST' })
    } catch (err: any) {
      if (err?.code === 'EEXIST') throw err
      // destination missing -> safe to rename
    }
    await this.sftpPool.rename(env, oldPath, newPath)
  }

  async deleteEntry(env: Environment, rawPath: string): Promise<void> {
    const targetPath = await this.normalizePath(env, rawPath)
    if (targetPath === '/' || targetPath === '') {
      throw new Error('Refusing to delete root path')
    }
    if (env.kind === 'local') {
      await fsp.rm(targetPath, { recursive: true, force: true })
      return
    }
    await this.sftpPool.rmRecursive(env, targetPath)
  }

  async createReadStream(env: Environment, rawPath: string): Promise<Readable> {
    const targetPath = await this.normalizePath(env, rawPath)
    if (env.kind === 'local') {
      return fs.createReadStream(targetPath, { highWaterMark: 64 * 1024 })
    }
    return this.sftpPool.createReadStream(env, targetPath)
  }

  async createWriteStream(env: Environment, rawPath: string, newFileMode?: number): Promise<Writable> {
    const targetPath = await this.normalizePath(env, rawPath)
    if (env.kind === 'local') {
      await fsp.mkdir(path.dirname(targetPath), { recursive: true })
      return fs.createWriteStream(targetPath, {
        highWaterMark: 64 * 1024,
        ...(newFileMode !== undefined ? { mode: newFileMode } : {})
      })
    }
    await this.sftpPool.mkdirRecursive(env, path.posix.dirname(targetPath))
    return this.sftpPool.createWriteStream(env, targetPath, newFileMode)
  }

  async getGitBranch(env: Environment, rawDir: string): Promise<string | null> {
    const dir = await this.normalizePath(env, rawDir)
    if (env.kind === 'local') {
      return new Promise((resolve) => {
        execFile('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 3000 }, (err, stdout) => {
          resolve(err ? null : stdout.trim() || null)
        })
      })
    }
    try {
      const res = await this.controlMaster.exec(
        env,
        `git -C ${shellQuote(dir)} rev-parse --abbrev-ref HEAD 2>/dev/null`,
        { timeoutMs: 4000, reuseOnly: true }
      )
      return res.code === 0 ? res.stdout.trim() || null : null
    } catch {
      return null
    }
  }

  async getGitStatus(env: Environment, rawDir: string): Promise<GitStatusEntry[]> {
    const dir = await this.normalizePath(env, rawDir)
    const parsePorcelain = (stdout: string): GitStatusEntry[] => {
      const entries: GitStatusEntry[] = []
      for (const line of stdout.split('\n')) {
        if (line.length < 4) continue
        const status = line.slice(0, 2).trim()
        let relPath = line.slice(3).trim()
        if (relPath.includes(' -> ')) {
          relPath = relPath.split(' -> ').pop() || relPath
        }
        const fullPath = path.posix.join(dir, relPath.replace(/^"|"$/g, ''))
        entries.push({ path: fullPath, status })
      }
      return entries
    }

    if (env.kind === 'local') {
      return new Promise((resolve) => {
        execFile('git', ['-C', dir, 'status', '--porcelain'], { timeout: 4000 }, (err, stdout) => {
          resolve(err ? [] : parsePorcelain(stdout))
        })
      })
    }

    try {
      const res = await this.controlMaster.exec(
        env,
        `git -C ${shellQuote(dir)} status --porcelain 2>/dev/null`,
        { timeoutMs: 5000, reuseOnly: true }
      )
      return res.code === 0 ? parsePorcelain(res.stdout) : []
    } catch {
      return []
    }
  }

  disposeEnv(envId: string): void {
    this.sftpPool.dispose(envId)
  }

  disposeAll(): void {
    this.sftpPool.disposeAll()
  }
}
