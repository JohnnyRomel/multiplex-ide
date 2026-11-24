import { spawn, execFile } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Environment } from '@shared/types'

export class SshControlMaster {
  private ctlDir: string
  private homeCache = new Map<string, string>()

  constructor(baseDir?: string) {
    // Keep socket path short! macOS Unix domain socket max path length is 104 bytes.
    this.ctlDir = baseDir ?? path.join(os.tmpdir(), `mide-ssh-${process.getuid?.() ?? 'u'}`)
    fs.mkdirSync(this.ctlDir, { recursive: true, mode: 0o700 })
  }

  getControlPath(env: Environment): string {
    const hash = crypto.createHash('sha1').update(env.id).digest('hex').slice(0, 12)
    return path.join(this.ctlDir, `ctl-${hash}`)
  }

  buildBaseSshArgs(env: Environment, opts?: { interactive?: boolean; batchMode?: boolean }): string[] {
    const ctlPath = this.getControlPath(env)
    const args: string[] = [
      '-o', `ControlPath=${ctlPath}`,
      '-o', 'ControlMaster=auto',
      '-o', 'ControlPersist=600',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3'
    ]

    if (opts?.batchMode) {
      args.push('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10')
    } else if (!opts?.interactive) {
      args.push('-o', 'ConnectTimeout=15')
    }

    // Only pass explicit -p / -J / -i if not delegating to ~/.ssh/config alias
    if (env.source !== 'ssh-config') {
      if (env.port && env.port !== 22) {
        args.push('-p', String(env.port))
      }
      if (env.proxyJump) {
        args.push('-J', env.proxyJump)
      }
      if (env.identityFile) {
        args.push('-i', env.identityFile)
      }
    }

    return args
  }

  getSshDestination(env: Environment): string {
    // If backed by ~/.ssh/config alias (or host equals alias without explicit custom hostname override), pass alias directly
    if (env.source === 'ssh-config' && env.host) {
      return env.host
    }
    const hostPart = env.hostname || env.host || env.name
    if (env.user && !hostPart.includes('@')) {
      return `${env.user}@${hostPart}`
    }
    return hostPart
  }

  async isConnected(env: Environment): Promise<boolean> {
    if (env.kind === 'local') return true
    const ctlPath = this.getControlPath(env)
    if (!fs.existsSync(ctlPath)) return false

    return new Promise((resolve) => {
      execFile(
        'ssh',
        ['-O', 'check', '-o', `ControlPath=${ctlPath}`, this.getSshDestination(env)],
        { timeout: 4000 },
        (err) => resolve(!err)
      )
    })
  }

  /**
   * Ensures an active ControlMaster connection exists (auto-connects silently if SSH keys/agent allow).
   */
  async ensureConnected(env: Environment): Promise<boolean> {
    if (env.kind === 'local') return true
    if (await this.isConnected(env)) return true
    const res = await this.connect(env)
    return res.ok
  }

  async connect(env: Environment): Promise<{ ok: boolean; needsInteractiveAuth?: boolean; error?: string }> {
    if (env.kind === 'local') return { ok: true }
    if (await this.isConnected(env)) return { ok: true }

    const args = [
      ...this.buildBaseSshArgs(env, { batchMode: true }),
      '-f',
      '-N',
      this.getSshDestination(env)
    ]

    return new Promise((resolve) => {
      const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        resolve({ ok: false, error: 'SSH connection timed out' })
      }, 12000)

      child.on('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) {
          resolve({ ok: true })
        } else {
          const authHint =
            /permission denied|keyboard-interactive|passphrase|password|verification code|host key verification/i.test(
              stderr
            )
          resolve({
            ok: false,
            needsInteractiveAuth: authHint,
            error: stderr.trim() || `SSH exited with code ${code}`
          })
        }
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        resolve({ ok: false, error: err.message })
      })
    })
  }

  async disconnect(env: Environment): Promise<void> {
    if (env.kind === 'local') return
    this.homeCache.delete(env.id)
    const ctlPath = this.getControlPath(env)
    if (!fs.existsSync(ctlPath)) return

    await new Promise<void>((resolve) => {
      execFile(
        'ssh',
        ['-O', 'exit', '-o', `ControlPath=${ctlPath}`, this.getSshDestination(env)],
        { timeout: 3000 },
        () => resolve()
      )
    })
  }

  async exec(
    env: Environment,
    remoteCommand: string,
    opts?: { timeoutMs?: number; batchMode?: boolean }
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    const args = [
      ...this.buildBaseSshArgs(env, { batchMode: opts?.batchMode ?? true }),
      this.getSshDestination(env),
      remoteCommand
    ]

    return new Promise((resolve, reject) => {
      const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      const timer = opts?.timeoutMs
        ? setTimeout(() => {
            child.kill('SIGTERM')
            reject(new Error(`Remote command timed out after ${opts.timeoutMs}ms`))
          }, opts.timeoutMs)
        : null

      child.stdout.on('data', (d) => {
        stdout += d.toString()
      })
      child.stderr.on('data', (d) => {
        stderr += d.toString()
      })
      child.on('error', (err) => {
        if (timer) clearTimeout(timer)
        reject(err)
      })
      child.on('close', (code) => {
        if (timer) clearTimeout(timer)
        resolve({ stdout, stderr, code: code ?? 1 })
      })
    })
  }

  async resolveHomeDir(env: Environment): Promise<string> {
    if (env.kind === 'local') return os.homedir()
    const cached = this.homeCache.get(env.id)
    if (cached) return cached

    try {
      const res = await this.exec(env, 'printf %s "$HOME"', { timeoutMs: 8000 })
      const home = res.stdout.trim()
      if (res.code === 0 && home.startsWith('/')) {
        this.homeCache.set(env.id, home)
        return home
      }
    } catch {
      // fallback
    }
    return '/'
  }

  async normalizePath(env: Environment, rawPath: string): Promise<string> {
    if (env.kind === 'local') {
      if (!rawPath || rawPath === '~') return os.homedir()
      if (rawPath.startsWith('~/')) return path.join(os.homedir(), rawPath.slice(2))
      return rawPath
    }
    if (!rawPath || rawPath === '~') {
      return this.resolveHomeDir(env)
    }
    if (rawPath.startsWith('~/')) {
      const home = await this.resolveHomeDir(env)
      return path.posix.join(home, rawPath.slice(2))
    }
    return rawPath
  }

  spawnSftpSubsystem(env: Environment) {
    const args = [
      ...this.buildBaseSshArgs(env, { batchMode: true }),
      '-s',
      this.getSshDestination(env),
      'sftp'
    ]
    return spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
  }

  spawnRemoteCommand(env: Environment, command: string) {
    const args = [
      ...this.buildBaseSshArgs(env, { batchMode: true }),
      this.getSshDestination(env),
      command
    ]
    return spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
  }

  async cleanupAll(envs: Environment[]): Promise<void> {
    await Promise.allSettled(envs.filter((e) => e.kind === 'ssh').map((e) => this.disconnect(e)))
  }
}
