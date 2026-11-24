import type { ChildProcessWithoutNullStreams } from 'child_process'
import type { Readable, Writable } from 'stream'
import path from 'path'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SFTPStream } = require('ssh2-streams') as { SFTPStream: new () => any }
import type { Environment, FileEntry } from '@shared/types'
import type { SshControlMaster } from '../ssh/controlMaster'

export interface SftpStats {
  size: number
  mtime: number // seconds
  mode: number
  isDirectory(): boolean
  isSymbolicLink(): boolean
  isFile(): boolean
}

interface PooledSftp {
  proc: ChildProcessWithoutNullStreams
  sftp: any
  ready: Promise<any>
  closed: boolean
}

function formatModePermissions(mode?: number): string | undefined {
  if (typeof mode !== 'number') return undefined
  const perms = mode & 0o777
  const chars = ['r', 'w', 'x']
  let out = ''
  for (let i = 8; i >= 0; i--) {
    out += (perms & (1 << i)) ? chars[(8 - i) % 3] : '-'
  }
  return out
}

/**
 * Provides full SFTP file operations and streams over macOS OpenSSH's
 * multiplexed ControlMaster channel (`ssh -s <host> sftp`), avoiding pure-JS
 * SSH authentication limitations (ProxyCommand, SSO, 2FA, certificates).
 */
export class OpenSshSftpPool {
  private pool = new Map<string, PooledSftp>()

  constructor(private controlMaster: SshControlMaster) {}

  async getSession(env: Environment): Promise<any> {
    const existing = this.pool.get(env.id)
    if (existing && !existing.closed) {
      return existing.ready
    }

    const proc = this.controlMaster.spawnSftpSubsystem(env)
    const sftp = new SFTPStream()
    let stderrBuf = ''

    const entry: PooledSftp = {
      proc,
      sftp,
      closed: false,
      ready: Promise.resolve(sftp)
    }

    entry.ready = new Promise<any>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          this.dispose(env.id)
          reject(new Error(`SFTP connection to ${env.name} timed out. Ensure SSH is connected via terminal first if password/2FA is required.`))
        }
      }, 15_000)

      const fail = (err: Error) => {
        entry.closed = true
        if (this.pool.get(env.id) === entry) {
          this.pool.delete(env.id)
        }
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(err)
        }
      }

      proc.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString()
      })

      proc.on('error', (err) => fail(err))
      proc.on('close', (code) => {
        fail(new Error(stderrBuf.trim() || `SFTP channel closed (code ${code ?? 'unknown'})`))
      })

      sftp.on('error', (err: Error) => fail(err))
      sftp.on('close', () => {
        entry.closed = true
        if (this.pool.get(env.id) === entry) {
          this.pool.delete(env.id)
        }
      })

      sftp.on('ready', () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve(sftp)
        }
      })

      proc.stdout.pipe(sftp)
      sftp.pipe(proc.stdin)
    })

    this.pool.set(env.id, entry)
    return entry.ready
  }

  dispose(envId: string): void {
    const entry = this.pool.get(envId)
    if (!entry) return
    entry.closed = true
    this.pool.delete(envId)
    try {
      entry.sftp.end()
    } catch {
      // ignore
    }
    try {
      entry.proc.kill('SIGTERM')
    } catch {
      // ignore
    }
  }

  disposeAll(): void {
    for (const envId of Array.from(this.pool.keys())) {
      this.dispose(envId)
    }
  }

  async stat(env: Environment, remotePath: string): Promise<SftpStats> {
    const sftp = await this.getSession(env)
    return new Promise((resolve, reject) => {
      sftp.stat(remotePath, (err: Error | null, stats: SftpStats) => {
        if (err) reject(err)
        else resolve(stats)
      })
    })
  }

  async lstat(env: Environment, remotePath: string): Promise<SftpStats> {
    const sftp = await this.getSession(env)
    return new Promise((resolve, reject) => {
      sftp.lstat(remotePath, (err: Error | null, stats: SftpStats) => {
        if (err) reject(err)
        else resolve(stats)
      })
    })
  }

  async readdir(env: Environment, remoteDir: string): Promise<FileEntry[]> {
    const sftp = await this.getSession(env)
    const rawList: any[] = await new Promise((resolve, reject) => {
      sftp.readdir(remoteDir, (err: Error | null, list: any[]) => {
        if (err) reject(err)
        else resolve(list || [])
      })
    })

    const entries: FileEntry[] = []
    for (const item of rawList) {
      const name: string = item.filename
      if (name === '.' || name === '..') continue
      const attrs = item.attrs || {}
      const mode: number = attrs.mode ?? 0
      const fileType = mode & 0o170000
      const isSymlink = fileType === 0o120000
      let isDirectory = fileType === 0o040000
      const fullPath = path.posix.join(remoteDir, name)

      if (isSymlink) {
        try {
          const targetStats = await this.stat(env, fullPath)
          isDirectory = targetStats.isDirectory()
        } catch {
          isDirectory = false
        }
      }

      entries.push({
        name,
        path: fullPath,
        envId: env.id,
        isDirectory,
        isSymlink,
        size: attrs.size ?? 0,
        mtimeMs: (attrs.mtime ?? 0) * 1000,
        permissions: formatModePermissions(mode)
      })
    }

    return entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
  }

  async readFileBuffer(env: Environment, remotePath: string, maxBytes = 8 * 1024 * 1024): Promise<Buffer> {
    const stats = await this.stat(env, remotePath)
    if (stats.size > maxBytes) {
      throw new Error(`File is too large (${(stats.size / 1024 / 1024).toFixed(1)} MB). Max preview size is ${(maxBytes / 1024 / 1024).toFixed(0)} MB.`)
    }
    const stream = await this.createReadStream(env, remotePath)
    const chunks: Buffer[] = []
    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      stream.on('end', () => resolve(Buffer.concat(chunks)))
      stream.on('error', reject)
    })
  }

  async writeFileBuffer(env: Environment, remotePath: string, data: Buffer): Promise<void> {
    const stream = await this.createWriteStream(env, remotePath)
    return new Promise((resolve, reject) => {
      stream.on('error', reject)
      stream.on('close', () => resolve())
      stream.on('finish', () => resolve())
      stream.end(data)
    })
  }

  async mkdir(env: Environment, remoteDir: string): Promise<void> {
    const sftp = await this.getSession(env)
    return new Promise((resolve, reject) => {
      sftp.mkdir(remoteDir, (err: Error | null) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  async mkdirRecursive(env: Environment, remoteDir: string): Promise<void> {
    const parts = remoteDir.split('/').filter(Boolean)
    let current = remoteDir.startsWith('/') ? '/' : ''
    for (const part of parts) {
      current = current === '/' ? `/${part}` : current ? `${current}/${part}` : part
      try {
        const st = await this.stat(env, current)
        if (!st.isDirectory()) {
          throw new Error(`Path exists and is not a directory: ${current}`)
        }
      } catch {
        try {
          await this.mkdir(env, current)
        } catch (err: any) {
          // Ignore already-exists races
          try {
            const st = await this.stat(env, current)
            if (!st.isDirectory()) throw err
          } catch {
            throw err
          }
        }
      }
    }
  }

  async rename(env: Environment, oldPath: string, newPath: string): Promise<void> {
    const sftp = await this.getSession(env)
    return new Promise((resolve, reject) => {
      sftp.rename(oldPath, newPath, (err: Error | null) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  async unlink(env: Environment, remotePath: string): Promise<void> {
    const sftp = await this.getSession(env)
    return new Promise((resolve, reject) => {
      sftp.unlink(remotePath, (err: Error | null) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  async rmdir(env: Environment, remoteDir: string): Promise<void> {
    const sftp = await this.getSession(env)
    return new Promise((resolve, reject) => {
      sftp.rmdir(remoteDir, (err: Error | null) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  async rmRecursive(env: Environment, targetPath: string): Promise<void> {
    const st = await this.lstat(env, targetPath)
    if (!st.isDirectory() || st.isSymbolicLink()) {
      await this.unlink(env, targetPath)
      return
    }
    const entries = await this.readdir(env, targetPath)
    for (const child of entries) {
      await this.rmRecursive(env, child.path)
    }
    await this.rmdir(env, targetPath)
  }

  async createReadStream(env: Environment, remotePath: string): Promise<Readable> {
    const sftp = await this.getSession(env)
    return sftp.createReadStream(remotePath, { highWaterMark: 64 * 1024 })
  }

  async createWriteStream(env: Environment, remotePath: string): Promise<Writable> {
    const sftp = await this.getSession(env)
    return sftp.createWriteStream(remotePath, { highWaterMark: 64 * 1024 })
  }
}
