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

export interface SshConnectResult {
  ok: boolean
  needsInteractiveAuth?: boolean
  nonRetryable?: boolean
  error?: string
}

const AUTH_HINT_RE =
  /permission denied|keyboard-interactive|passphrase|password|verification code|two-factor|2fa|otp|enter pin/i
const NON_RETRYABLE_SSH_RE =
  /host key verification failed|offending .* key|remote host identification has changed|bad configuration option|invalid argument/i

export function classifySshError(stderr: string): {
  needsInteractiveAuth: boolean
  nonRetryable: boolean
} {
  const text = stderr || ''
  if (NON_RETRYABLE_SSH_RE.test(text)) {
    return { needsInteractiveAuth: false, nonRetryable: true }
  }
  if (AUTH_HINT_RE.test(text)) {
    return { needsInteractiveAuth: true, nonRetryable: false }
  }
  return { needsInteractiveAuth: false, nonRetryable: false }
}

/**
 * Parses `Master running (pid=12345)` emitted by `ssh -O check`.
 */
export function parseControlMasterPid(output: string): number | null {
  const m = /Master running\s*\(pid=(\d+)\)/i.exec(output || '')
  if (!m) return null
  const pid = parseInt(m[1], 10)
  return Number.isFinite(pid) && pid > 1 ? pid : null
}

/**
 * Detects sshd refusing a NEW channel on an otherwise healthy multiplexed connection — typically
 * `MaxSessions` (default 10) exhausted by many tabs + SFTP + probes. The transport is alive, so this
 * must NEVER be treated as a dead master (tearing it down would drop every open pane!).
 */
export function isChannelLimitError(text: string): boolean {
  return /administratively prohibited|session open refused|open failed: (?:administratively|resource)|no more sessions|too many sessions/i.test(
    text || ''
  )
}

function isSafePrivateDir(dir: string): boolean {
  try {
    const st = fs.lstatSync(dir)
    const uid = process.getuid?.()
    if (!st.isDirectory() || st.isSymbolicLink()) return false
    if (uid !== undefined && st.uid !== uid) return false
    return (st.mode & 0o077) === 0
  } catch {
    return false
  }
}

function resolveShortControlDir(baseDir?: string): string {
  if (baseDir) return baseDir
  const uid = process.getuid?.() ?? 'u'
  // Prefer `/tmp/mide-ssh-<uid>` (~17 bytes) over macOS `os.tmpdir()` (`/var/folders/.../T`, ~49 bytes)
  // because macOS Unix domain socket paths cap at 104 bytes AND OpenSSH appends a 17-byte temp suffix!
  // Only used if it is a real directory owned by us with no group/other access (shared /tmp safety).
  const preferred = `/tmp/mide-ssh-${uid}`
  try {
    fs.mkdirSync(preferred, { recursive: true, mode: 0o700 })
    if (isSafePrivateDir(preferred)) return preferred
  } catch {
    // fall through
  }
  const fallback = path.join(os.tmpdir(), `mide-ssh-${uid}`)
  fs.mkdirSync(fallback, { recursive: true, mode: 0o700 })
  return fallback
}

export class SshControlMaster {
  private ctlDir: string
  private homeCache = new Map<string, string>()
  private resetLocks = new Map<string, Promise<void>>()
  private connectLocks = new Map<string, Promise<SshConnectResult>>()
  private verifyLocks = new Map<string, Promise<boolean>>()
  private lastResetAt = new Map<string, number>()
  private lastConnectedAt = new Map<string, number>()

  constructor(baseDir?: string) {
    this.ctlDir = resolveShortControlDir(baseDir)
    fs.mkdirSync(this.ctlDir, { recursive: true, mode: 0o700 })
  }

  getControlPath(env: Environment): string {
    const hash = crypto.createHash('sha1').update(env.id).digest('hex').slice(0, 12)
    return path.join(this.ctlDir, `ctl-${hash}`)
  }

  buildBaseSshArgs(
    env: Environment,
    opts?: { interactive?: boolean; batchMode?: boolean; reuseOnly?: boolean }
  ): string[] {
    const ctlPath = this.getControlPath(env)
    const args: string[] = [
      '-o', `ControlPath=${ctlPath}`,
      '-o', opts?.reuseOnly ? 'ControlMaster=no' : 'ControlMaster=auto',
      '-o', 'ControlPersist=600',
      // 15s × 3 = 45s tolerance: absorbs transient corporate VPN / ProxyCommand hiccups without
      // dropping every tab, while still catching genuinely dead connections promptly!
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'TCPKeepAlive=yes'
    ]

    if (opts?.batchMode) {
      args.push('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20')
    } else {
      // Bound connect timeout generously enough for ProxyCommand / ProxyJump gateways (12-18s cold dial)
      args.push('-o', 'ConnectTimeout=20')
    }

    if (opts?.reuseOnly) {
      // Strict mux-only: `ControlMaster=no` alone silently FALLS BACK to a brand-new direct connection
      // when the socket is dead. Forcing ProxyCommand to /usr/bin/false makes that fallback fail in
      // ~40ms instead of dialing VPN/bastion/ProxyCommand from background probes & git polling.
      args.push('-o', 'ProxyCommand=/usr/bin/false')
    }

    if (env.source !== 'ssh-config') {
      if (env.port && env.port !== 22) {
        args.push('-p', String(env.port))
      }
      if (env.proxyJump && !opts?.reuseOnly) {
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

  /**
   * Checks local ControlMaster process liveness via `ssh -O check` and returns its PID if running.
   * NOTE: This only proves the LOCAL mux process exists — use `verifyEndToEnd()` to prove the remote
   * tunnel/ProxyCommand is not wedged or half-open!
   */
  async getMasterPid(env: Environment): Promise<number | null> {
    if (env.kind === 'local') return null
    const ctlPath = this.getControlPath(env)
    if (!fs.existsSync(ctlPath)) return null

    return new Promise((resolve) => {
      execFile(
        '/usr/bin/ssh',
        ['-O', 'check', '-o', `ControlPath=${ctlPath}`, this.getSshDestination(env)],
        { timeout: 3000, env: buildEnrichedEnv() },
        (err, stdout, stderr) => {
          if (err) {
            resolve(null)
            return
          }
          resolve(parseControlMasterPid(`${stdout}\n${stderr}`) ?? -1)
        }
      )
    })
  }

  async isConnected(env: Environment): Promise<boolean> {
    if (env.kind === 'local') return true
    const pid = await this.getMasterPid(env)
    return pid !== null
  }

  /**
   * Proves the existing ControlMaster socket can actually reach the remote sshd end-to-end
   * (`-o ControlMaster=no` guarantees this NEVER dials a brand-new SSH connection!).
   * Deduplicated per env so concurrent callers share a single fast (~30ms) probe.
   */
  async verifyEndToEnd(env: Environment, timeoutMs = 5000): Promise<boolean> {
    if (env.kind === 'local') return true
    const ctlPath = this.getControlPath(env)
    if (!fs.existsSync(ctlPath)) return false

    const existing = this.verifyLocks.get(env.id)
    if (existing) return existing

    const task = (async (): Promise<boolean> => {
      const pid = await this.getMasterPid(env)
      if (pid === null) return false

      try {
        const res = await this.exec(env, 'printf __MIDE_ALIVE__', {
          timeoutMs,
          batchMode: true,
          reuseOnly: true
        })
        if (res.code === 0 && res.stdout.includes('__MIDE_ALIVE__')) return true
        // sshd refused a new channel (MaxSessions) => transport is alive, just saturated
        return isChannelLimitError(res.stderr)
      } catch {
        return false
      }
    })()

    this.verifyLocks.set(env.id, task)
    try {
      return await task
    } finally {
      if (this.verifyLocks.get(env.id) === task) {
        this.verifyLocks.delete(env.id)
      }
    }
  }

  /**
   * Tears down a stale, wedged, or dead ControlMaster socket (including terminating a hung local
   * mux PID when `ssh -O exit` times out!).
   * Serialized & deduplicated per environment so sibling tabs never collide.
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
      // Only skip non-forced reset if end-to-end tunnel is genuinely responsive
      if (await this.verifyEndToEnd(env, 3500)) {
        return
      }
    }

    const task = (async () => {
      this.lastResetAt.set(env.id, Date.now())
      const masterPid = await this.getMasterPid(env).catch(() => null)

      await new Promise<void>((resolve) => {
        execFile(
          '/usr/bin/ssh',
          ['-O', 'exit', '-o', `ControlPath=${ctlPath}`, this.getSshDestination(env)],
          { timeout: 2000, env: buildEnrichedEnv() },
          () => resolve()
        )
      })

      // If `ssh -O exit` couldn't stop a wedged mux process (e.g. hung ProxyCommand), terminate its PID cleanly
      if (masterPid && masterPid > 1) {
        try {
          process.kill(masterPid, 0) // throws ESRCH if already exited
          try {
            process.kill(masterPid, 'SIGTERM')
          } catch {
            // ignore race
          }
          await new Promise((r) => setTimeout(r, 150))
          try {
            process.kill(masterPid, 0)
            process.kill(masterPid, 'SIGKILL')
          } catch {
            // already exited
          }
        } catch {
          // already exited cleanly
        }
      }

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
   * Ensures a leftover dead or half-open wedged socket never poisons subsequent SSH sessions.
   * If a fresh master is currently being dialed, waits for it instead of tearing it down mid-handshake.
   */
  async cleanIfDeadSocket(env: Environment): Promise<void> {
    if (env.kind === 'local') return
    const inFlight = this.connectLocks.get(env.id)
    if (inFlight) {
      await inFlight.catch(() => undefined)
      return
    }
    const ctlPath = this.getControlPath(env)
    if (!fs.existsSync(ctlPath)) return
    const healthy = await this.verifyEndToEnd(env, 4000)
    if (!healthy && !this.connectLocks.has(env.id)) {
      await this.resetControlSocket(env, { force: true })
    }
  }

  /**
   * Coordinates ONE healthy end-to-end ControlMaster per environment across all panes & SFTP.
   * Reuses the existing master whenever end-to-end verification succeeds (a single failing pane must
   * never tear down a master that siblings are actively using); only a genuinely dead/wedged master is
   * replaced, and concurrent callers share the single in-flight dial.
   */
  async ensureHealthyMaster(env: Environment): Promise<SshConnectResult> {
    if (env.kind === 'local') return { ok: true }

    const inFlight = this.connectLocks.get(env.id)
    if (inFlight) {
      return inFlight
    }

    if (await this.verifyEndToEnd(env, 4500)) {
      return { ok: true }
    }

    return this.connect(env, { forceReset: true })
  }

  async ensureConnected(env: Environment): Promise<boolean> {
    if (env.kind === 'local') return true
    const res = await this.ensureHealthyMaster(env)
    return res.ok
  }

  /**
   * Connects like VS Code Remote-SSH:
   * 1. Deduplicated per environment via `connectLocks` so multiple tabs / SFTP / sidebar never race.
   * 2. Tears down any stale/wedged control socket before fresh dial.
   * 3. Attempts `-f -N` ControlMaster bootstrap (works for standard OpenSSH hosts).
   * 4. Falls back to `ssh <baseArgs> -T <dest> 'printf __MIDE_OK__'` for bastion / container gateways
   *    whose ProxyCommand or sshd rejects `-N` without an exec channel!
   */
  async connect(env: Environment, opts?: { forceReset?: boolean }): Promise<SshConnectResult> {
    if (env.kind === 'local') return { ok: true }
    if (!opts?.forceReset && (await this.verifyEndToEnd(env, 4000))) {
      return { ok: true }
    }

    const existingConnect = this.connectLocks.get(env.id)
    if (existingConnect) {
      return existingConnect
    }

    const task = this.connectInternal(env, Boolean(opts?.forceReset))
    this.connectLocks.set(env.id, task)
    try {
      return await task
    } finally {
      if (this.connectLocks.get(env.id) === task) {
        this.connectLocks.delete(env.id)
      }
    }
  }

  private async connectInternal(env: Environment, forceReset: boolean): Promise<SshConnectResult> {
    if (!forceReset && (await this.verifyEndToEnd(env, 4000))) {
      return { ok: true }
    }

    // Clear stale/wedged socket file & hung mux PID before fresh dial
    await this.resetControlSocket(env, { force: true })

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
          resolve({ code: 124, stdout, stderr: stderr || 'SSH connection timed out (22s)' })
        }, 22_000)

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
    if (first.code === 0) {
      this.lastConnectedAt.set(env.id, Date.now())
      return { ok: true }
    }

    const firstClass = classifySshError(first.stderr)
    if (firstClass.needsInteractiveAuth || firstClass.nonRetryable) {
      return {
        ok: false,
        needsInteractiveAuth: firstClass.needsInteractiveAuth,
        nonRetryable: firstClass.nonRetryable,
        error: first.stderr.trim() || `SSH exited with code ${first.code}`
      }
    }

    // If Try 1 failed due to transport timeout/refusal/proxy failure, don't burn another 22s on Try 2!
    if (
      first.code === 124 ||
      /timed out|connection refused|could not resolve|network is unreachable|no route to host/i.test(first.stderr)
    ) {
      return {
        ok: false,
        error: first.stderr.trim() || `SSH exited with code ${first.code}`
      }
    }

    // Try 2: Exec probe (compatible with container / bastion proxies that disallow `-N`)
    const second = await runProbe(['-T'], 'printf __MIDE_OK__').catch(() => ({
      code: 1,
      stdout: '',
      stderr: ''
    }))
    if (second.code === 0 && second.stdout.includes('__MIDE_OK__')) {
      this.lastConnectedAt.set(env.id, Date.now())
      return { ok: true }
    }

    const errMsg = (second.stderr || first.stderr).trim() || `SSH exited with code ${first.code}`
    const secondClass = classifySshError(errMsg)
    return {
      ok: false,
      needsInteractiveAuth: secondClass.needsInteractiveAuth,
      nonRetryable: secondClass.nonRetryable,
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
    opts?: { timeoutMs?: number; batchMode?: boolean; reuseOnly?: boolean }
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    if (opts?.reuseOnly) {
      const ctlPath = this.getControlPath(env)
      if (!fs.existsSync(ctlPath)) {
        return { stdout: '', stderr: 'No active ControlMaster socket', code: 255 }
      }
    }

    const args = [
      ...this.buildBaseSshArgs(env, {
        batchMode: opts?.batchMode ?? true,
        reuseOnly: opts?.reuseOnly
      }),
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
