import fs from 'fs'
import os from 'os'
import * as pty from 'node-pty'
import type {
  Environment,
  RecoverableTmuxSession,
  TerminalCreateOptions,
  TerminalNotification,
  TerminalSessionInfo,
  TerminalStatusEvent
} from '@shared/types'
import { expandLocalTilde } from '../ssh/configParser'
import { buildEnrichedEnv, type SshControlMaster } from '../ssh/controlMaster'

// Covers >2.5 minutes of server reboot / VPN switch / Wi-Fi roam with progressive backoff
const RECONNECT_BACKOFF_MS = [1500, 2500, 4000, 6000, 9000, 12000, 15000, 20000, 25000, 30000]
const DEFAULT_RECENT_TMUX_MAX_AGE_SEC = 3600

interface ManagedTerminal {
  info: TerminalSessionInfo
  ptyProcess: pty.IPty | null
  env: Environment
  options: TerminalCreateOptions
  oscBuffer: string
  tmuxSession?: string
  attachRecentPending: boolean
  awaitingTmuxAttach: boolean
  state: TerminalStatusEvent['state']
  closedByUser: boolean
  reconnectPaused: boolean
  reconnectAttempt: number
  reconnectTimer: NodeJS.Timeout | null
  sshCheckTimer: NodeJS.Timeout | null
  lastSpawnAt: number
  isReattach: boolean
  spawnGeneration: number
}

export interface TerminalEvents {
  onData: (terminalId: string, data: string) => void
  onExit: (terminalId: string, envId: string, exitCode: number) => void
  onStatus: (status: TerminalStatusEvent) => void
  onNotification: (notification: TerminalNotification) => void
  onSshConnected: (envId: string) => void
  onSshDisconnected?: (envId: string) => void
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
 * Extracts and strips our hidden OSC 9991 marker (`\x1b]9991;<sessionName>\x07`) emitted
 * right before `exec tmux attach-session` so TerminalManager learns the exact re-attached session.
 */
export function extractMideTmuxMarker(data: string): { cleaned: string; sessionName?: string } {
  let sessionName: string | undefined
  const cleaned = data.replace(/\x1b\]9991;([a-zA-Z0-9_-]+)\x07/g, (_m, name: string) => {
    sessionName = name
    return ''
  })
  return { cleaned, sessionName }
}

/**
 * Parses `NOW` + `tmux list-sessions` tab-separated output into recently active, unattached
 * MultiplexIDE-managed (`mide_*`) sessions within `maxAgeSec` (default: 1 hour).
 */
export function parseRecoverableTmuxOutput(
  stdout: string,
  maxAgeSec = DEFAULT_RECENT_TMUX_MAX_AGE_SEC,
  ownedSessions?: Set<string>
): RecoverableTmuxSession[] {
  const lines = stdout.split(/\r?\n/)
  let remoteNow = Math.floor(Date.now() / 1000)
  const results: RecoverableTmuxSession[] = []

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('__NOW__:')) {
      const parsed = parseInt(line.slice(8), 10)
      if (Number.isFinite(parsed) && parsed > 0) remoteNow = parsed
      continue
    }
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const name = parts[0]?.trim() || ''
    const lastActivityEpoch = parseInt(parts[1], 10)
    const attached = parseInt(parts[2], 10)
    const command = (parts[3] || '').trim()
    const cwd = (parts[4] || '').trim() || undefined

    if (!name.startsWith('mide_')) continue
    if (!Number.isFinite(lastActivityEpoch) || lastActivityEpoch <= 0) continue
    if (!Number.isFinite(attached) || attached > 0) continue
    if (ownedSessions?.has(name)) continue

    const ageSec = Math.max(0, remoteNow - lastActivityEpoch)
    if (ageSec > maxAgeSec) continue

    results.push({
      name,
      ageSec,
      lastActivityEpoch,
      attached,
      command,
      cwd
    })
  }

  return results.sort((a, b) => a.ageSec - b.ageSec)
}

/**
 * Builds the remote POSIX shell bootstrap command for persistent per-pane `tmux` sessions:
 * - Optionally (`attachRecent: true`) discovers and re-attaches the most recently active unattached
 *   `mide_*` session within `maxAgeSec` (default 1 hour) so sessions survive full IDE restarts!
 * - Enables `mouse on` so mouse wheel scrolling works natively inside TUI agents (`agy`, vim, htop)
 *   and scrolls tmux history (`copy-mode -e`) instead of xterm translating wheel-up into Up-Arrow!
 * - Injects OSC 52 (`Ms`) terminfo override + `set-clipboard on` so remote selection copies to macOS clipboard.
 * - Hides tmux status bar so each pane looks & feels like a clean native terminal.
 */
export function buildRemoteTmuxBootstrapCommand(
  tmuxSession: string,
  targetDir?: string,
  opts?: { attachRecent?: boolean; maxAgeSec?: number; excludeSessions?: string[] }
): string {
  const fallbackQuoted = shellQuote(tmuxSession)
  const cdCmd = remoteCdSnippet(targetDir)
  const maxAge = Math.max(60, Math.floor(opts?.maxAgeSec ?? DEFAULT_RECENT_TMUX_MAX_AGE_SEC))
  const exclStr = opts?.excludeSessions?.length ? `|${opts.excludeSessions.join('|')}|` : ''

  const findRecentSnippet = opts?.attachRecent
    ? `MIDE_NOW=$(date +%s); ` +
      `MIDE_FOUND=$(tmux list-sessions -F '#{session_activity} #{session_attached} #{session_name}' 2>/dev/null | ` +
      `awk -v now="$MIDE_NOW" -v maxage="${maxAge}" -v excl=${shellQuote(exclStr)} ` +
      `'$1 ~ /^[0-9]+$/ && $2 == 0 && $3 ~ /^mide_/ && (now - $1) <= maxage && (excl == "" || index(excl, "|" $3 "|") == 0) {print $1, $3}' | ` +
      `sort -rn | head -n 1 | awk '{print $2}'); ` +
      `if [ -n "$MIDE_FOUND" ]; then MIDE_S="$MIDE_FOUND"; fi; `
    : ''

  // NOTE: `'\;'` (quoted backslash-semicolon) is critical for tmux CLI `bind-key`:
  // unquoted `\;` passes a bare `;` to tmux, which tmux interprets as its own top-level
  // command separator and truncates the keybinding to just `select-pane`!
  return (
    `if command -v tmux >/dev/null 2>&1; then ` +
    `MIDE_S=${fallbackQuoted}; ` +
    findRecentSnippet +
    `if ! tmux has-session -t "$MIDE_S" 2>/dev/null; then ${cdCmd}tmux new-session -d -s "$MIDE_S"; fi; ` +
    `tmux set-option -t "$MIDE_S" status off >/dev/null 2>&1 || true; ` +
    `tmux set-option -g mouse on >/dev/null 2>&1 || true; ` +
    `tmux set-option -t "$MIDE_S" mouse on >/dev/null 2>&1 || true; ` +
    `tmux set-option -sg escape-time 10 >/dev/null 2>&1 || true; ` +
    `tmux set-option -t "$MIDE_S" history-limit 50000 >/dev/null 2>&1 || true; ` +
    `tmux set-option -as terminal-overrides ',xterm*:Ms=\\E]52;%p1%s;%p2%s\\007' >/dev/null 2>&1 || true; ` +
    `tmux set-option -s set-clipboard on >/dev/null 2>&1 || true; ` +
    `tmux set-option -g set-clipboard on >/dev/null 2>&1 || true; ` +
    `tmux bind-key -T copy-mode WheelUpPane select-pane '\\;' send-keys -X -N 3 scroll-up >/dev/null 2>&1 || true; ` +
    `tmux bind-key -T copy-mode WheelDownPane select-pane '\\;' send-keys -X -N 3 scroll-down >/dev/null 2>&1 || true; ` +
    `tmux bind-key -T copy-mode-vi WheelUpPane select-pane '\\;' send-keys -X -N 3 scroll-up >/dev/null 2>&1 || true; ` +
    `tmux bind-key -T copy-mode-vi WheelDownPane select-pane '\\;' send-keys -X -N 3 scroll-down >/dev/null 2>&1 || true; ` +
    `printf '\\033]9991;%s\\007' "$MIDE_S"; ` +
    `exec tmux attach-session -t "$MIDE_S"; ` +
    `else ${cdCmd}exec \${SHELL:-/bin/bash} -l; fi`
  )
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
    const explicitTmux = useTmux && options.tmuxSession ? options.tmuxSession : undefined
    const tmuxSession = useTmux ? explicitTmux || `mide_${shortTag}` : undefined
    const attachRecentPending = Boolean(useTmux && !explicitTmux && options.attachRecentTmux)

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
      attachRecentPending,
      awaitingTmuxAttach: attachRecentPending,
      state: env.kind === 'local' ? 'connected' : 'connecting',
      closedByUser: false,
      reconnectPaused: false,
      reconnectAttempt: 0,
      reconnectTimer: null,
      sshCheckTimer: null,
      lastSpawnAt: 0,
      isReattach: Boolean(explicitTmux),
      spawnGeneration: 0
    }

    this.sessions.set(id, managed)
    void this.prepareAndSpawnPty(managed)
    return info
  }

  private getOwnedTmuxSessions(envId: string, excludeTerminalId?: string): Set<string> {
    const owned = new Set<string>()
    for (const [id, sess] of this.sessions) {
      if (id === excludeTerminalId) continue
      if (sess.env.id === envId && sess.tmuxSession) {
        owned.add(sess.tmuxSession)
      }
    }
    return owned
  }

  /**
   * Lists unattached MultiplexIDE (`mide_*`) tmux sessions on `env` that were active within `maxAgeSec`
   * (default: 1 hour) and are not already claimed by any open pane in this app instance.
   */
  async listRecoverableTmuxSessions(
    env: Environment,
    maxAgeSec = DEFAULT_RECENT_TMUX_MAX_AGE_SEC
  ): Promise<RecoverableTmuxSession[]> {
    if (env.kind !== 'ssh' || !env.useTmux) return []
    const connected = await this.controlMaster.isConnected(env)
    if (!connected) return []

    // If an initial pane is currently attaching via `attachRecentPending`, wait briefly for its
    // OSC 9991 confirmation so we never double-attach the exact same session in a second tab!
    const deadline = Date.now() + 1500
    while (Date.now() < deadline) {
      const anyAwaiting = Array.from(this.sessions.values()).some(
        (s) => s.env.id === env.id && s.awaitingTmuxAttach && !s.closedByUser
      )
      if (!anyAwaiting) break
      await new Promise((r) => setTimeout(r, 120))
    }

    const probeCmd =
      `if command -v tmux >/dev/null 2>&1; then ` +
      `printf '__NOW__:%s\\n' "$(date +%s)"; ` +
      `tmux list-sessions -F '#{session_name}\t#{session_activity}\t#{session_attached}\t#{pane_current_command}\t#{pane_current_path}' 2>/dev/null || true; ` +
      `fi`

    try {
      const res = await this.controlMaster.exec(env, probeCmd, { timeoutMs: 4000 })
      const owned = this.getOwnedTmuxSessions(env.id)
      return parseRecoverableTmuxOutput(res.stdout, maxAgeSec, owned).slice(0, 6)
    } catch {
      return []
    }
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

  private async prepareAndSpawnPty(managed: ManagedTerminal): Promise<void> {
    if (managed.closedByUser) return
    const gen = ++managed.spawnGeneration
    if (managed.env.kind === 'ssh') {
      await this.controlMaster.cleanIfDeadSocket(managed.env).catch(() => {})
    }
    if (managed.closedByUser || managed.spawnGeneration !== gen) return
    this.spawnPty(managed)
  }

  private resolveSafeLocalCwd(rawPath?: string): string {
    const home = os.homedir()
    if (!rawPath) return home
    const expanded = expandLocalTilde(rawPath)
    if (expanded.startsWith('/')) {
      try {
        if (fs.existsSync(expanded) && fs.statSync(expanded).isDirectory()) {
          return expanded
        }
      } catch {
        // fallback to homedir
      }
    }
    return home
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
      const candidateShell = process.env.SHELL
      file = candidateShell && fs.existsSync(candidateShell) ? candidateShell : '/bin/zsh'
      args = ['-l']
      cwd = this.resolveSafeLocalCwd(options.cwd || env.defaultPath)
    } else {
      file = '/usr/bin/ssh'
      const baseArgs = this.controlMaster.buildBaseSshArgs(env, { interactive: true })
      const dest = this.controlMaster.getSshDestination(env)
      const targetDir = options.cwd || (env.defaultPath && env.defaultPath !== '~' ? env.defaultPath : undefined)
      const cdCmd = remoteCdSnippet(targetDir)

      if (managed.tmuxSession) {
        const shouldAttachRecent = managed.attachRecentPending && !managed.isReattach
        const owned = Array.from(this.getOwnedTmuxSessions(env.id, managed.info.id))
        const remoteCmd = buildRemoteTmuxBootstrapCommand(managed.tmuxSession, targetDir, {
          attachRecent: shouldAttachRecent,
          maxAgeSec: managed.options.recentMaxAgeSec ?? DEFAULT_RECENT_TMUX_MAX_AGE_SEC,
          excludeSessions: owned
        })
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
    const ptyEnv = {
      ...enrichedEnv,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: process.env.LANG || 'en_US.UTF-8',
      MULTIPLEX_IDE: '1',
      MULTIPLEX_ENV_ID: env.id
    }

    let ptyProcess: pty.IPty
    try {
      ptyProcess = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: ptyEnv
      })
    } catch (err: any) {
      if (env.kind === 'local') {
        ptyProcess = pty.spawn('/bin/zsh', ['-l'], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: os.homedir(),
          env: ptyEnv
        })
      } else {
        managed.state = 'disconnected'
        this.events.onData(managed.info.id, `\r\n\x1b[31mFailed to spawn SSH PTY: ${err?.message || err}\x1b[0m\r\n`)
        this.emitStatus(managed, { message: err?.message || 'Failed to spawn SSH' })
        return
      }
    }

    managed.ptyProcess = ptyProcess
    // Apply latest terminal dimensions if UI fitted while prepareAndSpawnPty was awaiting
    if (managed.info.cols !== cols || managed.info.rows !== rows) {
      try {
        ptyProcess.resize(managed.info.cols, managed.info.rows)
      } catch {
        // ignore
      }
    }

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
      let data = env.kind === 'ssh' ? stripEraseScrollback(rawData) : rawData

      // Parse hidden OSC 9991 marker emitted right before `exec tmux attach-session`
      // so we record the exact remote tmux session name (crucial when auto-reattaching a <1h session!)
      if (env.kind === 'ssh' && data.includes('\x1b]9991;')) {
        const { cleaned, sessionName } = extractMideTmuxMarker(data)
        data = cleaned
        if (sessionName) {
          const wasAutoRecovered = managed.attachRecentPending && sessionName !== managed.tmuxSession
          managed.tmuxSession = sessionName
          managed.info.tmuxSession = sessionName
          managed.attachRecentPending = false
          managed.awaitingTmuxAttach = false
          this.emitStatus(
            managed,
            wasAutoRecovered ? { message: `Reattached active tmux session (${sessionName}) on ${env.name}` } : undefined
          )
        }
      }

      if (data) {
        this.events.onData(managed.info.id, data)
      }

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

      // Sync environment status if the shared ControlMaster also went down
      void this.controlMaster.isConnected(env).then((alive) => {
        if (!alive) {
          this.events.onSshDisconnected?.(env.id)
        }
      })

      if (cleanUserExit || managed.reconnectPaused) {
        managed.state = 'disconnected'
        this.events.onData(
          managed.info.id,
          `\r\n\x1b[90m─── Session ended (exit ${exitCode ?? 0}). Press Enter or click ↻ to reconnect ───\x1b[0m\r\n`
        )
        this.emitStatus(managed, { exitCode, message: 'Session ended — press Enter or ↻' })
        return
      }

      // Abnormal disconnect (e.g. code 255 broken pipe / sleep-wake / network drop): auto-reconnect with backoff!
      this.scheduleAutoReconnect(managed, exitCode)
    })
  }

  private scheduleAutoReconnect(managed: ManagedTerminal, exitCode?: number): void {
    if (managed.closedByUser || managed.reconnectPaused) return
    const attempt = managed.reconnectAttempt + 1
    const maxAttempts = RECONNECT_BACKOFF_MS.length

    if (attempt > maxAttempts) {
      managed.state = 'disconnected'
      this.events.onData(
        managed.info.id,
        `\r\n\x1b[31m─── Disconnected from ${managed.env.name}. Press Enter, Space, or click ↻ to reconnect ───\x1b[0m\r\n`
      )
      this.emitStatus(managed, {
        exitCode,
        attempt: maxAttempts,
        maxAttempts,
        message: 'Auto-reconnect paused — press Enter or click ↻'
      })
      return
    }

    managed.reconnectAttempt = attempt
    const baseDelay = RECONNECT_BACKOFF_MS[attempt - 1]
    // Add 0..350ms jitter so multiple tabs/splits on the same host don't race each other
    const jitter = Math.floor(Math.random() * 350)
    const delayMs = baseDelay + jitter
    managed.state = 'reconnecting'
    this.events.onData(
      managed.info.id,
      `\r\n\x1b[33m─── Connection lost (code ${exitCode ?? '?'}). Reconnecting to ${managed.env.name} in ${(baseDelay / 1000).toFixed(1)}s (${attempt}/${maxAttempts})... ───\x1b[0m\r\n`
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
      if (managed.closedByUser || managed.reconnectPaused) return
      // Serialized per-env socket check/reset prevents sibling tabs from tearing down a fresh master
      await this.controlMaster.cleanIfDeadSocket(managed.env).catch(() => {})
      if (managed.closedByUser || managed.reconnectPaused) return
      managed.isReattach = true
      this.spawnPty(managed)
    }, delayMs)
  }

  /**
   * Pauses automatic reconnect retries on a pane (preserving scrollback) until user manually reconnects.
   */
  pauseReconnect(terminalId: string): void {
    const managed = this.sessions.get(terminalId)
    if (!managed || managed.closedByUser) return
    managed.reconnectPaused = true
    if (managed.reconnectTimer) {
      clearTimeout(managed.reconnectTimer)
      managed.reconnectTimer = null
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
    this.emitStatus(managed, { message: 'Reconnect paused — press Enter or ↻' })
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

    managed.reconnectPaused = false
    managed.spawnGeneration++

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
      if (opts?.forceReset) {
        await this.controlMaster.resetControlSocket(managed.env).catch(() => {})
      } else {
        await this.controlMaster.cleanIfDeadSocket(managed.env).catch(() => {})
      }
    }

    if (!managed.closedByUser && !managed.reconnectPaused) {
      this.spawnPty(managed)
    }
  }

  /**
   * Called on macOS `powerMonitor.on('resume')` (wake from sleep) OR network `'online'` event
   * to recover disconnected/stale SSH panes grouped cleanly per environment without socket races!
   */
  async handleSystemResume(): Promise<void> {
    const byEnv = new Map<string, ManagedTerminal[]>()
    for (const managed of this.sessions.values()) {
      if (managed.env.kind !== 'ssh' || managed.closedByUser || managed.reconnectPaused) continue
      const list = byEnv.get(managed.env.id) || []
      list.push(managed)
      byEnv.set(managed.env.id, list)
    }

    await Promise.allSettled(
      Array.from(byEnv.values()).map(async (panes) => {
        const env = panes[0].env
        const alive = await this.controlMaster.isConnected(env)
        if (!alive) {
          await this.controlMaster.resetControlSocket(env, { force: true }).catch(() => {})
        }
        const targets = alive
          ? panes.filter((p) => p.state === 'disconnected' || p.state === 'reconnecting')
          : panes
        for (let i = 0; i < targets.length; i++) {
          if (i > 0) {
            await new Promise((r) => setTimeout(r, 180))
          }
          void this.reconnect(targets[i].info.id, { forceReset: false })
        }
      })
    )
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
    } else if (
      managed.env.kind === 'ssh' &&
      managed.state !== 'reconnecting' &&
      (data === '\r' || data === '\n' || data === ' ')
    ) {
      // Pressing Enter or Space in a disconnected SSH pane immediately triggers in-place reconnect!
      void this.reconnect(terminalId, { forceReset: false })
    }
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const sess = this.sessions.get(terminalId)
    if (!sess) return
    const safeCols = Math.max(10, Math.min(500, Math.floor(cols)))
    const safeRows = Math.max(4, Math.min(200, Math.floor(rows)))
    if (sess.info.cols === safeCols && sess.info.rows === safeRows) {
      return
    }
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
