import os from 'os'
import * as pty from 'node-pty'
import type {
  Environment,
  TerminalCreateOptions,
  TerminalNotification,
  TerminalSessionInfo,
  TerminalStatusEvent
} from '@shared/types'
import { buildEnrichedEnv, type SshControlMaster } from '../ssh/controlMaster'

const RECONNECT_BACKOFF_MS = [1500, 3000, 5000, 8000, 12000, 15000]

interface ManagedTerminal {
  info: TerminalSessionInfo
  ptyProcess: pty.IPty | null
  env: Environment
  options: TerminalCreateOptions
  oscBuffer: string
  tmuxSession?: string
  state: TerminalStatusEvent['state']
  closedByUser: boolean
  reconnectAttempt: number
  reconnectTimer: NodeJS.Timeout | null
  sshCheckTimer: NodeJS.Timeout | null
  lastSpawnAt: number
  isReattach: boolean
}

export interface TerminalEvents {
  onData: (terminalId: string, data: string) => void
  onExit: (terminalId: string, envId: string, exitCode: number) => void
  onStatus: (status: TerminalStatusEvent) => void
  onNotification: (notification: TerminalNotification) => void
  onSshConnected: (envId: string) => void
}

/**
 * Strips ESC[3J (Erase Saved Lines / Clear Scrollback) when re-attaching a terminal so
 * remote tmux/login banners NEVER wipe out the user's local xterm scrollback history!
 */
export function stripEraseScrollback(data: string): string {
  return data.includes('\x1b[3J') ? data.replace(/\x1b\[3J/g, '') : data
}

export function parseOscNotifications(chunk: string): Array<{ title?: string; body?: string }> {
  const results: Array<{ title?: string; body?: string }> = []
  const regex = /\x1b\](9|99|777);([^\x07\x1b]*?)(?:\x07|\x1b\\)/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(chunk)) !== null) {
    const code = match[1]
    const payload = match[2]
    if (code === '9') {
      if (!payload.startsWith('4;')) {
        results.push({ title: 'Terminal Notification', body: payload })
      }
    } else if (code === '777') {
      const parts = payload.split(';')
      if (parts[0] === 'notify') {
        results.push({ title: parts[1] || 'Notification', body: parts.slice(2).join(';') })
      }
    } else if (code === '99') {
      const semiIdx = payload.indexOf(';')
      const body = semiIdx >= 0 ? payload.slice(semiIdx + 1) : payload
      if (body.trim()) {
        results.push({ title: 'Terminal Notification', body })
      }
    }
  }
  return results
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function remoteCdSnippet(targetDir?: string): string {
  if (!targetDir || targetDir === '~') return ''
  if (targetDir.startsWith('~/')) {
    const rel = targetDir.slice(2)
    return `cd "$HOME"/${shellQuote(rel)} 2>/dev/null || cd "$HOME" 2>/dev/null || true; `
  }
  return `cd ${shellQuote(targetDir)} 2>/dev/null || true; `
}

/**
 * Manages local & SSH terminals with cmux-style seamless disconnect/reconnect:
 * - Each terminal pane retains its stable `terminalId` and xterm scrollback across disconnects.
 * - SSH panes automatically use a dedicated per-pane remote `tmux` session (`mide_<shortId>`, status bar hidden)
 *   when `tmux` is available on the host, so running commands, cwd, and processes survive network drops & Mac sleep!
 * - Automatic exponential-backoff reconnect + instant manual reconnect + macOS wake-from-sleep reconnect.
 */
export class TerminalManager {
  private sessions = new Map<string, ManagedTerminal>()
  private counter = 0

  constructor(
    private controlMaster: SshControlMaster,
    private events: TerminalEvents
  ) {}

  create(env: Environment, options: TerminalCreateOptions): TerminalSessionInfo {
    const seq = ++this.counter
    const shortTag = `${seq}_${Date.now().toString(36).slice(-4)}`
    const id = `term-${shortTag}`
    const cols = options.cols || 100
    const rows = options.rows || 30
    const useTmux = env.kind === 'ssh' && (options.useTmux ?? env.useTmux)
    const tmuxSession = useTmux ? `mide_${shortTag}` : undefined

    const info: TerminalSessionInfo = {
      id,
      envId: env.id,
      title: options.title || (env.kind === 'local' ? 'zsh' : env.name),
      cwd: options.cwd || env.defaultPath,
      cols,
      rows,
      createdAt: Date.now(),
      tmuxSession
    }

    const managed: ManagedTerminal = {
      info,
      ptyProcess: null,
      env,
      options: { ...options, cols, rows, useTmux },
      oscBuffer: '',
      tmuxSession,
      state: env.kind === 'local' ? 'connected' : 'connecting',
      closedByUser: false,
      reconnectAttempt: 0,
      reconnectTimer: null,
      sshCheckTimer: null,
      lastSpawnAt: 0,
      isReattach: false
    }

    this.sessions.set(id, managed)
    this.spawnPty(managed)
    return info
  }

  private emitStatus(managed: ManagedTerminal, extra?: Partial<TerminalStatusEvent>): void {
    this.events.onStatus({
      terminalId: managed.info.id,
      envId: managed.env.id,
      state: managed.state,
      tmuxSession: managed.tmuxSession,
      ...extra
    })
  }

  private spawnPty(managed: ManagedTerminal): void {
    if (managed.closedByUser) return
    if (managed.reconnectTimer) {
      clearTimeout(managed.reconnectTimer)
      managed.reconnectTimer = null
    }
    if (managed.sshCheckTimer) {
      clearInterval(managed.sshCheckTimer)
      managed.sshCheckTimer = null
    }

    const { env, options } = managed
    const cols = managed.info.cols || 100
    const rows = managed.info.rows || 30

    let file: string
    let args: string[]
    let cwd = os.homedir()

    if (env.kind === 'local') {
      file = process.env.SHELL || '/bin/zsh'
      args = ['-l']
      const candidate = options.cwd || env.defaultPath
      if (candidate && candidate.startsWith('/')) {
        cwd = candidate
      }
    } else {
      file = '/usr/bin/ssh'
      const baseArgs = this.controlMaster.buildBaseSshArgs(env, { interactive: true })
      const dest = this.controlMaster.getSshDestination(env)
      const targetDir = options.cwd || (env.defaultPath && env.defaultPath !== '~' ? env.defaultPath : undefined)
      const cdCmd = remoteCdSnippet(targetDir)

      if (managed.tmuxSession) {
        const s = shellQuote(managed.tmuxSession)
        // Compatible with tmux 1.8 - 3.5+: creates session in targetDir on first run,
        // re-attaches live on reconnect without changing cwd or killing processes!
        const remoteCmd =
          `if command -v tmux >/dev/null 2>&1; then ` +
          `if ! tmux has-session -t ${s} 2>/dev/null; then ${cdCmd}tmux new-session -d -s ${s}; fi; ` +
          `tmux set-option -t ${s} status off >/dev/null 2>&1 || true; ` +
          `tmux set-option -t ${s} history-limit 50000 >/dev/null 2>&1 || true; ` +
          `tmux set-option -s set-clipboard on >/dev/null 2>&1 || true; ` +
          `exec tmux attach-session -t ${s}; ` +
          `else ${cdCmd}exec \${SHELL:-/bin/bash} -l; fi`
        args = [...baseArgs, '-t', dest, remoteCmd]
      } else if (cdCmd) {
        const remoteCmd = `${cdCmd}exec \${SHELL:-/bin/bash} -l`
        args = [...baseArgs, '-t', dest, remoteCmd]
      } else {
        args = [...baseArgs, dest]
      }
    }

    managed.lastSpawnAt = Date.now()
    managed.state = env.kind === 'local' ? 'connected' : managed.isReattach ? 'reconnecting' : 'connecting'
    this.emitStatus(managed)

    const enrichedEnv = buildEnrichedEnv()
    const ptyProcess = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...enrichedEnv,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        LANG: process.env.LANG || 'en_US.UTF-8',
        MULTIPLEX_IDE: '1',
        MULTIPLEX_ENV_ID: env.id
      }
    })

    managed.ptyProcess = ptyProcess

    let notifiedSshReady = env.kind === 'local'
    let checking = false
    const checkReady = async () => {
      if (notifiedSshReady || checking || managed.closedByUser || managed.ptyProcess !== ptyProcess) return
      checking = true
      try {
        if (await this.controlMaster.isConnected(env)) {
          notifiedSshReady = true
          managed.state = 'connected'
          managed.reconnectAttempt = 0
          this.emitStatus(managed)
          this.events.onSshConnected(env.id)
        }
      } finally {
        checking = false
      }
    }

    if (env.kind === 'ssh') {
      managed.sshCheckTimer = setInterval(checkReady, 1800)
    }

    ptyProcess.onData((rawData) => {
      if (managed.ptyProcess !== ptyProcess) return
      // Strip ESC[3J on SSH sessions so tmux re-attach never wipes local scrollback
      const data = env.kind === 'ssh' ? stripEraseScrollback(rawData) : rawData
      this.events.onData(managed.info.id, data)

      if (env.kind === 'ssh') {
        if (managed.state !== 'connected' && Date.now() - managed.lastSpawnAt > 400) {
          void checkReady()
        }
        // Reset backoff counter once session stays healthy for > 8 seconds
        if (managed.reconnectAttempt > 0 && Date.now() - managed.lastSpawnAt > 8000) {
          managed.reconnectAttempt = 0
        }
      }

      if (data.includes('\x1b]')) {
        const combined = (managed.oscBuffer + data).slice(-4096)
        const notifications = parseOscNotifications(combined)
        for (const n of notifications) {
          this.events.onNotification({
            terminalId: managed.info.id,
            envId: env.id,
            kind: 'osc',
            title: n.title,
            body: n.body,
            timestamp: Date.now()
          })
        }
        const lastEsc = combined.lastIndexOf('\x1b]')
        if (lastEsc >= 0 && !combined.slice(lastEsc).includes('\x07') && !combined.slice(lastEsc).includes('\x1b\\')) {
          managed.oscBuffer = combined.slice(lastEsc)
        } else {
          managed.oscBuffer = ''
        }
      }
    })

    ptyProcess.onExit(({ exitCode }) => {
      // Ignore exit from an older PTY replaced by manual reconnect()
      if (managed.ptyProcess !== ptyProcess) return
      if (managed.sshCheckTimer) {
        clearInterval(managed.sshCheckTimer)
        managed.sshCheckTimer = null
      }
      managed.ptyProcess = null

      if (managed.closedByUser) {
        this.sessions.delete(managed.info.id)
        this.events.onExit(managed.info.id, env.id, exitCode)
        return
      }

      // Local shell exited -> remove pane as usual
      if (env.kind === 'local') {
        this.sessions.delete(managed.info.id)
        this.events.onExit(managed.info.id, env.id, exitCode)
        return
      }

      // SSH terminal exited: NEVER destroy the pane or clear xterm scrollback!
      const livedMs = Date.now() - managed.lastSpawnAt
      const cleanUserExit = exitCode === 0 && livedMs > 3000

      if (cleanUserExit) {
        managed.state = 'disconnected'
        this.events.onData(
          managed.info.id,
          `\r\n\x1b[90m─── Session ended (exit 0). Press Enter or click ↻ to reconnect ───\x1b[0m\r\n`
        )
        this.emitStatus(managed, { exitCode, message: 'Session ended' })
        return
      }

      // Abnormal disconnect (e.g. code 255 broken pipe / sleep-wake / network drop): auto-reconnect with backoff!
      this.scheduleAutoReconnect(managed, exitCode)
    })
  }

  private scheduleAutoReconnect(managed: ManagedTerminal, exitCode?: number): void {
    if (managed.closedByUser) return
    const attempt = managed.reconnectAttempt + 1
    const maxAttempts = RECONNECT_BACKOFF_MS.length

    if (attempt > maxAttempts) {
      managed.state = 'disconnected'
      this.events.onData(
        managed.info.id,
        `\r\n\x1b[31m─── Disconnected from ${managed.env.name}. Press Enter or click ↻ to reconnect ───\x1b[0m\r\n`
      )
      this.emitStatus(managed, {
        exitCode,
        attempt: maxAttempts,
        maxAttempts,
        message: 'Auto-reconnect paused — click Reconnect or press Enter'
      })
      return
    }

    managed.reconnectAttempt = attempt
    const delayMs = RECONNECT_BACKOFF_MS[attempt - 1]
    managed.state = 'reconnecting'
    this.events.onData(
      managed.info.id,
      `\r\n\x1b[33m─── Connection lost (code ${exitCode ?? '?'}). Reconnecting to ${managed.env.name} in ${(delayMs / 1000).toFixed(1)}s (${attempt}/${maxAttempts})... ───\x1b[0m\r\n`
    )
    this.emitStatus(managed, {
      exitCode,
      attempt,
      maxAttempts,
      nextRetryMs: delayMs,
      message: `Reconnecting (${attempt}/${maxAttempts})...`
    })

    managed.reconnectTimer = setTimeout(async () => {
      managed.reconnectTimer = null
      if (managed.closedByUser) return
      // Clean stale control socket if it's dead before re-spawning
      const alive = await this.controlMaster.isConnected(managed.env)
      if (!alive) {
        await this.controlMaster.resetControlSocket(managed.env)
      }
      if (managed.closedByUser) return
      managed.isReattach = true
      this.spawnPty(managed)
    }, delayMs)
  }

  /**
   * Reconnects a terminal pane IN-PLACE under the exact same terminalId — preserving 100% of
   * xterm scrollback and re-attaching the pane's remote tmux session seamlessly!
   */
  async reconnect(terminalId: string, opts?: { forceReset?: boolean; env?: Environment }): Promise<void> {
    const managed = this.sessions.get(terminalId)
    if (!managed || managed.closedByUser) return

    if (opts?.env) {
      managed.env = opts.env
    }

    if (managed.reconnectTimer) {
      clearTimeout(managed.reconnectTimer)
      managed.reconnectTimer = null
    }
    if (managed.sshCheckTimer) {
      clearInterval(managed.sshCheckTimer)
      managed.sshCheckTimer = null
    }

    // Detach old PTY cleanly without firing normal exit deletion
    const oldPty = managed.ptyProcess
    managed.ptyProcess = null
    if (oldPty) {
      try {
        oldPty.kill()
      } catch {
        // ignore
      }
    }

    managed.reconnectAttempt = 0
    managed.isReattach = true
    managed.state = 'reconnecting'
    this.emitStatus(managed, { message: 'Reconnecting...' })
    this.events.onData(
      managed.info.id,
      `\r\n\x1b[36m─── Reconnecting to ${managed.env.name}${managed.tmuxSession ? ` (session ${managed.tmuxSession})` : ''}... ───\x1b[0m\r\n`
    )

    if (managed.env.kind === 'ssh') {
      const alive = opts?.forceReset ? false : await this.controlMaster.isConnected(managed.env)
      if (!alive) {
        await this.controlMaster.resetControlSocket(managed.env)
      }
    }

    if (!managed.closedByUser) {
      this.spawnPty(managed)
    }
  }

  /**
   * Called on macOS `powerMonitor.on('resume')` (wake from sleep) to proactively recover
   * any disconnected/reconnecting SSH panes immediately.
   */
  async handleSystemResume(): Promise<void> {
    for (const managed of this.sessions.values()) {
      if (managed.env.kind !== 'ssh' || managed.closedByUser) continue
      if (managed.state === 'disconnected' || managed.state === 'reconnecting') {
        void this.reconnect(managed.info.id, { forceReset: true })
      } else {
        // Probe if control socket died during sleep; if dead, reconnect gracefully in-place
        const alive = await this.controlMaster.isConnected(managed.env)
        if (!alive) {
          void this.reconnect(managed.info.id, { forceReset: true })
        }
      }
    }
  }

  /** Marks all SSH panes for an env as disconnected (preserving their panes & scrollback!) */
  disconnectEnv(envId: string): void {
    for (const managed of this.sessions.values()) {
      if (managed.env.id !== envId || managed.env.kind !== 'ssh') continue
      if (managed.reconnectTimer) {
        clearTimeout(managed.reconnectTimer)
        managed.reconnectTimer = null
      }
      if (managed.sshCheckTimer) {
        clearInterval(managed.sshCheckTimer)
        managed.sshCheckTimer = null
      }
      const oldPty = managed.ptyProcess
      managed.ptyProcess = null
      if (oldPty) {
        try {
          oldPty.kill()
        } catch {
          // ignore
        }
      }
      managed.state = 'disconnected'
      this.events.onData(
        managed.info.id,
        `\r\n\x1b[90m─── Disconnected by user (scrollback preserved). Press Enter or click ↻ to reconnect ───\x1b[0m\r\n`
      )
      this.emitStatus(managed, { message: 'Disconnected' })
    }
  }

  write(terminalId: string, data: string): void {
    const managed = this.sessions.get(terminalId)
    if (!managed) return
    if (managed.ptyProcess) {
      managed.ptyProcess.write(data)
    } else if (managed.env.kind === 'ssh' && (data === '\r' || data === '\n')) {
      // Pressing Enter in a disconnected SSH pane immediately triggers in-place reconnect!
      void this.reconnect(terminalId, { forceReset: true })
    }
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const sess = this.sessions.get(terminalId)
    if (!sess) return
    const safeCols = Math.max(10, Math.min(500, Math.floor(cols)))
    const safeRows = Math.max(4, Math.min(200, Math.floor(rows)))
    sess.info.cols = safeCols
    sess.info.rows = safeRows
    try {
      sess.ptyProcess?.resize(safeCols, safeRows)
    } catch {
      // ignore
    }
  }

  kill(terminalId: string, opts?: { destroyRemoteSession?: boolean }): void {
    const sess = this.sessions.get(terminalId)
    if (!sess) return
    sess.closedByUser = true
    if (sess.reconnectTimer) clearTimeout(sess.reconnectTimer)
    if (sess.sshCheckTimer) clearInterval(sess.sshCheckTimer)
    this.sessions.delete(terminalId)

    try {
      sess.ptyProcess?.kill()
    } catch {
      // ignore
    }

    // Clean up dedicated remote tmux session when user intentionally closes the pane
    if (opts?.destroyRemoteSession !== false && sess.env.kind === 'ssh' && sess.tmuxSession) {
      void this.controlMaster
        .exec(sess.env, `tmux kill-session -t ${shellQuote(sess.tmuxSession)} 2>/dev/null || true`, {
          timeoutMs: 3000
        })
        .catch(() => {})
    }
  }

  killAllForEnv(envId: string): void {
    for (const [id, sess] of this.sessions) {
      if (sess.info.envId === envId) {
        this.kill(id, { destroyRemoteSession: true })
      }
    }
  }

  killAll(): void {
    for (const id of Array.from(this.sessions.keys())) {
      // On app quit, detach without killing remote tmux sessions so work survives app restarts too!
      this.kill(id, { destroyRemoteSession: false })
    }
  }
}
