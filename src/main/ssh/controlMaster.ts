import { spawn, execFile } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Environment } from '@shared/types'

/**
 * Ensures OpenSSH ProxyCommand helpers (Homebrew binaries, ~/.local/bin, or custom dirs from local config)
 * are always discoverable even when MultiplexIDE is launched from macOS Finder/Dock.
 */
let configuredExtraPathDirs: string[] = []

export function setConfiguredExtraPathDirs(dirs: string[]): void {
  configuredExtraPathDirs = dirs.filter(Boolean)
}

export function buildEnrichedEnv(): NodeJS.ProcessEnv {
  const home = os.homedir()
  const extraPaths = [
    ...configuredExtraPathDirs,
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    path.join(home, '.local/bin'),
    path.join(home, '.cargo/bin'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ]
  const current = process.env.PATH ? process.env.PATH.split(':') : []
  const merged = Array.from(new Set([...extraPaths, ...current])).join(':')
  return {
    ...process.env,
    PATH: merged
  }
}

export class SshControlMaster {
  private ctlDir: string
  private homeCache = new Map<string, string>()
  private resetLocks = new Map<string, Promise<void>>()
  private connectLocks = new Map<string, Promise<{ ok: boolean; needsInteractiveAuth?: boolean; error?: string }>>()
  private lastResetAt = new Map<string, number>()

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
      '-o', 'ServerAliveInterval=10',
      '-o', 'ServerAliveCountMax=2',
      '-o', 'TCPKeepAlive=yes'
    ]

    if (opts?.batchMode) {
      args.push('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10')
    } else {
      // Bound connect timeout on interactive terminals too so dead Wi-Fi/VPN fails fast instead of hanging 75s
      args.push('-o', 'ConnectTimeout=12')
    }

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
        '/usr/bin/ssh',
        ['-O', 'check', '-o', `ControlPath=${ctlPath}`, this.getSshDestination(env)],
        { timeout: 3000, env: buildEnrichedEnv() },
        (err) => resolve(!err)
      )
    })
  }

  /**
   * Tears down a stale or dead ControlMaster socket (critical after macOS sleep/wake or VPN changes
   * so reconnecting terminals don't hang on a half-open dead socket!).
   * Serialized & deduplicated per environment so multi-tab / multi-split reconnects NEVER kill
   * a fresh socket just established by a sibling pane!
   */
  async resetControlSocket(env: Environment, opts?: { force?: boolean }): Promise<void> {
    if (env.kind === 'local') return
    const existingLock = this.resetLocks.get(env.id)
    if (existingLock) {
      await existingLock
      return
    }

    const ctlPath = this.getControlPath(env)
    if (!fs.existsSync(ctlPath)) return

    if (!opts?.force) {
      const sinceLast = Date.now() - (this.lastResetAt.get(env.id) || 0)
      if (sinceLast < 3500) {
        return
      }
      // Double-check if a sibling pane already brought the master back online
      if (await this.isConnected(env)) {
        return
      }
    }

    const task = (async () => {
      this.lastResetAt.set(env.id, Date.now())
      await new Promise<void>((resolve) => {
        execFile(
          '/usr/bin/ssh',
          ['-O', 'exit', '-o', `ControlPath=${ctlPath}`, this.getSshDestination(env)],
          { timeout: 2000, env: buildEnrichedEnv() },
          () => resolve()
        )
      })
      try {
        if (fs.existsSync(ctlPath)) fs.unlinkSync(ctlPath)
      } catch {
        // ignore unlink race
      }
    })()

    this.resetLocks.set(env.id, task)
    try {
      await task
    } finally {
      if (this.resetLocks.get(env.id) === task) {
        this.resetLocks.delete(env.id)
      }
    }
  }

  /**
   * Ensures a leftover dead socket file never blocks interactive `ControlMaster=auto` spawning.
   */
  async cleanIfDeadSocket(env: Environment): Promise<void> {
    if (env.kind === 'local') return
    const ctlPath = this.getControlPath(env)
    if (!fs.existsSync(ctlPath)) return
    const alive = await this.isConnected(env)
    if (!alive) {
      await this.resetControlSocket(env)
    }
  }

  async ensureConnected(env: Environment): Promise<boolean> {
    if (env.kind === 'local') return true
    if (await this.isConnected(env)) return true
    const res = await this.connect(env)
    return res.ok
  }

  /**
   * Connects like VS Code Remote-SSH:
   * 1. Cleans up any stale control socket if check failed.
   * 2. Attempts `-f -N` ControlMaster bootstrap (works for standard OpenSSH hosts).
   * 3. Falls back to `ssh <baseArgs> <dest> 'printf __MIDE_OK__'` for bastion / container gateways
   *    whose ProxyCommand or sshd rejects `-N` without an exec channel!
   */
  async connect(env: Environment): Promise<{ ok: boolean; needsInteractiveAuth?: boolean; error?: string }> {
    if (env.kind === 'local') return { ok: true }
    if (await this.isConnected(env)) return { ok: true }

    // Deduplicate concurrent connect() calls per environment so sidebar click, file tree,
    // and terminal bootstrap never race or reset each other's fresh ControlMaster socket!
    const existingConnect = this.connectLocks.get(env.id)
    if (existingConnect) {
      return existingConnect
    }

    const task = this.connectInternal(env)
    this.connectLocks.set(env.id, task)
    try {
      return await task
    } finally {
      if (this.connectLocks.get(env.id) === task) {
        this.connectLocks.delete(env.id)
      }
    }
  }

  private async connectInternal(
    env: Environment
  ): Promise<{ ok: boolean; needsInteractiveAuth?: boolean; error?: string }> {
    if (await this.isConnected(env)) return { ok: true }

    // Clear stale socket file before fresh dial
    await this.resetControlSocket(env)

    const envVars = buildEnrichedEnv()
    const dest = this.getSshDestination(env)
    const runProbe = (
      extraArgs: string[],
      remoteCmd?: string
    ): Promise<{ code: number; stdout: string; stderr: string }> =>
      new Promise((resolve) => {
        const args = [
          ...this.buildBaseSshArgs(env, { batchMode: true }),
          ...extraArgs,
          dest,
          ...(remoteCmd ? [remoteCmd] : [])
        ]
        const child = spawn('/usr/bin/ssh', args, { stdio: ['ignore', 'pipe', 'pipe'], env: envVars })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (c) => (stdout += c.toString()))
        child.stderr.on('data', (c) => (stderr += c.toString()))
        const timer = setTimeout(() => {
          child.kill('SIGTERM')
          resolve({ code: 124, stdout, stderr: stderr || 'SSH connection timed out' })
        }, 15000)

        child.on('exit', (code) => {
          clearTimeout(timer)
          resolve({ code: code ?? 1, stdout, stderr })
        })
        child.on('error', (err) => {
          clearTimeout(timer)
          resolve({ code: 1, stdout, stderr: err.message })
        })
      })

    // Try 1: Fast background master (-f -N)
    const first = await runProbe(['-f', '-N'])
    if (first.code === 0) return { ok: true }

    const authHint = (text: string) =>
      /permission denied|keyboard-interactive|passphrase|password|verification code|host key verification/i.test(text)

    if (authHint(first.stderr)) {
      return { ok: false, needsInteractiveAuth: true, error: first.stderr.trim() }
    }

    // Try 2: Exec probe (compatible with container / bastion proxies that disallow `-N`)
    const second = await runProbe(['-T'], 'printf __MIDE_OK__').catch(() => ({
      code: 1,
      stdout: '',
      stderr: ''
    }))
    if (second.code === 0 && second.stdout.includes('__MIDE_OK__')) {
      return { ok: true }
    }

    const errMsg = (second.stderr || first.stderr).trim() || `SSH exited with code ${first.code}`
    return {
      ok: false,
      needsInteractiveAuth: authHint(errMsg),
      error: errMsg
    }
  }

  async disconnect(env: Environment): Promise<void> {
    if (env.kind === 'local') return
    this.homeCache.delete(env.id)
    await this.resetControlSocket(env, { force: true })
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
      const child = spawn('/usr/bin/ssh', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildEnrichedEnv()
      })
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
    return spawn('/usr/bin/ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], env: buildEnrichedEnv() })
  }

  spawnRemoteCommand(env: Environment, command: string) {
    const args = [
      ...this.buildBaseSshArgs(env, { batchMode: true }),
      this.getSshDestination(env),
      command
    ]
    return spawn('/usr/bin/ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], env: buildEnrichedEnv() })
  }

  async cleanupAll(envs: Environment[]): Promise<void> {
    await Promise.allSettled(envs.filter((e) => e.kind === 'ssh').map((e) => this.disconnect(e)))
  }
}
