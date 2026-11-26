import fs from 'fs'
import os from 'os'
import path from 'path'
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

// Progressive backoff covering ~100s of VPN roam / gateway hiccup / server reboot without hammering proxies
const RECONNECT_BACKOFF_MS = [2000, 3500, 5000, 8000, 12000, 16000, 22000, 30000]
const DEFAULT_RECENT_TMUX_MAX_AGE_SEC = 3600
const HEALTH_CHECK_INTERVAL_MS = 25_000
const STABLE_CONNECTION_RESET_MS = 10_000
const IDLE_SHELL_COMMANDS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'csh', 'tcsh'])

let checkedSpawnHelperPerms = false

/**
 * Ensures macOS `node-pty` `spawn-helper` binaries have executable (+x) permissions so
 * `posix_spawnp` never fails with EACCES after fresh installs or app packaging.
 */
function ensureNodePtySpawnHelperExecutable(): void {
  if (checkedSpawnHelperPerms || process.platform !== 'darwin') return
  checkedSpawnHelperPerms = true
  try {
    const ptyEntry = require.resolve('node-pty')
    const ptyRoot = path.resolve(path.dirname(ptyEntry), '..')
    const candidates = [
      path.join(ptyRoot, 'build', 'Release', 'spawn-helper'),
      path.join(ptyRoot, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper'),
      path.join(ptyRoot, 'prebuilds', 'darwin-arm64', 'spawn-helper'),
      path.join(ptyRoot, 'prebuilds', 'darwin-x64', 'spawn-helper')
    ].map((p) => p.replace('app.asar', 'app.asar.unpacked'))

    for (const helperPath of candidates) {
      try {
        if (!fs.existsSync(helperPath)) continue
        const st = fs.statSync(helperPath)
        if ((st.mode & 0o111) === 0) {
          fs.chmodSync(helperPath, st.mode | 0o755)
        }
      } catch {
        // ignore read-only / race errors
      }
    }
  } catch {
    // ignore resolution failures in bundled/test environments
  }
}

function sanitizePtyEnv(rawEnv: NodeJS.ProcessEnv): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(rawEnv)) {
    if (v === undefined || k === 'ELECTRON_RUN_AS_NODE') continue
    clean[k] = String(v)
  }
  return clean
}

function summarizeSshError(raw?: string): string {
  if (!raw) return 'SSH connection failed'
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('** '))
  const picked = lines[lines.length - 1] || lines[0] || raw.trim()
  return picked.length > 140 ? `${picked.slice(0, 137)}...` : picked
}

/**
 * Detects tmux's client-detach notice (`[detached (from session ...)]`) so an intentional detach
 * or another pane taking over the session via `attach-session -d` NEVER triggers a ping-pong loop!
 */
export function isTmuxDetachOutput(outputTail: string): boolean {
  return /\[detached(?:\s+\(from session [^)]+\))?\]/i.test(outputTail || '')
}

interface ManagedTerminal {
  info: TerminalSessionInfo
  ptyProcess: pty.IPty | null
  env: Environment
  options: TerminalCreateOptions
  oscBuffer: string
  recentOutputTail: string
  tmuxSession?: string
  attachRecentPending: boolean
  awaitingTmuxAttach: boolean
  awaitingInteractiveAuth: boolean
  tmuxAttachWaiters: Array<() => void>
  state: TerminalStatusEvent['state']
  closedByUser: boolean
  reconnectPaused: boolean
  reconnectAttempt: number
  reconnectTimer: NodeJS.Timeout | null
  sshCheckTimer: NodeJS.Timeout | null
  stableTimer: NodeJS.Timeout | null
  postAttachResizeTimers: NodeJS.Timeout[]
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

export function isIdleShellCommand(command?: string): boolean {
  const base = (command || '').trim().replace(/^-/, '').split('/').pop()?.toLowerCase() || ''
  return !base || IDLE_SHELL_COMMANDS.has(base)
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
 * right before `exec tmux -u attach-session` so TerminalManager learns the exact re-attached session.
 */
export function extractMideTmuxMarker(data: string): { cleaned: string; sessionName?: string } {
  let sessionName: string | undefined
  const cleaned = data.replace(/\x1b\]9991;([a-zA-Z0-9_.-]+)\x07/g, (_m, name: string) => {
    sessionName = name
    return ''
  })
  return { cleaned, sessionName }
}

/**
 * Parses ALL tmux sessions from `NOW` + `tmux list-sessions` tab-separated output.
 * Useful for both automatic recovery and the interactive pane tmux session switcher.
 */
export function parseTmuxSessionsOutput(
  stdout: string,
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
    const windows = parts[5] ? parseInt(parts[5], 10) : undefined
    const size = (parts[6] || '').trim() || undefined

    if (!name) continue
    if (!Number.isFinite(lastActivityEpoch) || lastActivityEpoch <= 0) continue
    if (!Number.isFinite(attached) || attached < 0) continue

    const ageSec = Math.max(0, remoteNow - lastActivityEpoch)
    results.push({
      name,
      ageSec,
      lastActivityEpoch,
      attached,
      command,
      cwd,
      windows: Number.isFinite(windows) ? windows : undefined,
      size,
      isManaged: name.startsWith('mide_'),
      ownedByApp: ownedSessions?.has(name) ?? false
    })
  }

  return results
}

/**
 * Parses `NOW` + `tmux list-sessions` output into recently active MultiplexIDE-managed (`mide_*`)
 * sessions within `maxAgeSec` (default: 1 hour), prioritizing sessions running active non-shell
 * commands (such as `agy`, `python`, `vim`) over idle shells (`zsh`, `bash`)!
 */
export function parseRecoverableTmuxOutput(
  stdout: string,
  maxAgeSec = DEFAULT_RECENT_TMUX_MAX_AGE_SEC,
  ownedSessions?: Set<string>,
  opts?: { includeGhostAttached?: boolean }
): RecoverableTmuxSession[] {
  const all = parseTmuxSessionsOutput(stdout, ownedSessions)
  const filtered = all.filter((s) => {
    if (!s.isManaged) return false
    if (s.ownedByApp) return false
    if (!opts?.includeGhostAttached && s.attached > 0) return false
    if (s.ageSec > maxAgeSec) return false
    return true
  })

  return filtered.sort((a, b) => {
    // 1. Prefer genuinely unattached sessions over potentially ghost-attached ones
    if ((a.attached === 0) !== (b.attached === 0)) {
      return a.attached === 0 ? -1 : 1
    }
    // 2. Prefer active processes (`agy`, `claude`, `python`, `vim`, etc.) over idle empty shells
    const aActive = !isIdleShellCommand(a.command)
    const bActive = !isIdleShellCommand(b.command)
    if (aActive !== bActive) {
      return aActive ? -1 : 1
    }
    // 3. Most recently active first
    return a.ageSec - b.ageSec
  })
}

/**
 * Builds the remote POSIX shell bootstrap command for persistent per-pane `tmux` sessions:
 * - Uses `tmux -u` (explicit UTF-8) + `exec tmux -u attach-session -d -t "$MIDE_S"` so stale ghost
 *   clients left by abrupt Wi-Fi/VPN/sleep drops are evicted immediately and NEVER clamp pane size!
 * - Configures `default-terminal` (`tmux-256color` or `screen-256color`) instead of legacy 1995
 *   `TERM=screen`, preventing cursor misalignment in zsh/agy/TUI apps on tmux 2.8+!
 * - Optionally (`attachRecent: true`) discovers and re-attaches the highest-priority unattached
 *   `mide_*` session within `maxAgeSec` (prioritizing active non-shell processes like `agy` over idle shells).
 * - Enables `mouse on`, `aggressive-resize on`, `escape-time 10`, and idempotent OSC 52 clipboard
 *   overrides (checked before appending so server `terminal-overrides` never bloats across reconnects!).
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

  // Format: `<activity> <attached> <session_name> <pane_current_command>`
  // Putting session_name at $3 ensures spaces in pane_current_command never break parsing.
  const findRecentSnippet = opts?.attachRecent
    ? `MIDE_NOW=$(date +%s); ` +
      `MIDE_FOUND=$(tmux list-sessions -F '#{session_activity} #{session_attached} #{session_name} #{pane_current_command}' 2>/dev/null | ` +
      `awk -v now="$MIDE_NOW" -v maxage="${maxAge}" -v excl=${shellQuote(exclStr)} ` +
      `'$1 ~ /^[0-9]+$/ && $2 == 0 && $3 ~ /^mide_/ && (now - $1) <= maxage && (excl == "" || index(excl, "|" $3 "|") == 0) {` +
      `cmd=$4; sub(/^.*\\//, "", cmd); sub(/^-/, "", cmd); ` +
      `prio=(cmd == "zsh" || cmd == "bash" || cmd == "sh" || cmd == "fish" || cmd == "dash" || cmd == "") ? 0 : 1; ` +
      `print prio, $1, $3}' | ` +
      `sort -k1,1rn -k2,2rn | head -n 1 | awk '{print $3}'); ` +
      `if [ -n "$MIDE_FOUND" ]; then MIDE_S="$MIDE_FOUND"; fi; `
    : ''

  // NOTE: `'\;'` (quoted backslash-semicolon) is critical for tmux CLI `bind-key`:
  // unquoted `\;` passes a bare `;` to tmux, which tmux interprets as its own top-level
  // command separator and truncates the keybinding to just `select-pane`!
  return (
    `if command -v tmux >/dev/null 2>&1; then ` +
    `MIDE_S=${fallbackQuoted}; ` +
    `MIDE_TERM="screen-256color"; ` +
    `if infocmp tmux-256color >/dev/null 2>&1; then MIDE_TERM="tmux-256color"; fi; ` +
    findRecentSnippet +
    `if ! tmux has-session -t "$MIDE_S" 2>/dev/null; then ${cdCmd}tmux -u new-session -d -s "$MIDE_S" "TERM=$MIDE_TERM exec \${SHELL:-/bin/bash} -l"; fi; ` +
    `tmux set-option -s default-terminal "$MIDE_TERM" >/dev/null 2>&1 || true; ` +
    `tmux set-option -t "$MIDE_S" status off >/dev/null 2>&1 || true; ` +
    `tmux set-option -g mouse on >/dev/null 2>&1 || true; ` +
    `tmux set-option -t "$MIDE_S" mouse on >/dev/null 2>&1 || true; ` +
    `tmux set-option -sg escape-time 10 >/dev/null 2>&1 || true; ` +
    `tmux set-window-option -g aggressive-resize on >/dev/null 2>&1 || true; ` +
    `tmux set-option -g window-size latest >/dev/null 2>&1 || true; ` +
    `tmux set-option -t "$MIDE_S" history-limit 50000 >/dev/null 2>&1 || true; ` +
    `tmux show-options -s terminal-overrides 2>/dev/null | grep -q 'Ms=' || tmux set-option -as terminal-overrides ',xterm*:Ms=\\E]52;%p1%s;%p2%s\\007' >/dev/null 2>&1 || true; ` +
    `tmux set-option -s set-clipboard on >/dev/null 2>&1 || true; ` +
    `tmux set-option -g set-clipboard on >/dev/null 2>&1 || true; ` +
    `tmux bind-key -T copy-mode WheelUpPane select-pane '\\;' send-keys -X -N 3 scroll-up >/dev/null 2>&1 || true; ` +
    `tmux bind-key -T copy-mode WheelDownPane select-pane '\\;' send-keys -X -N 3 scroll-down >/dev/null 2>&1 || true; ` +
    `tmux bind-key -T copy-mode-vi WheelUpPane select-pane '\\;' send-keys -X -N 3 scroll-up >/dev/null 2>&1 || true; ` +
    `tmux bind-key -T copy-mode-vi WheelDownPane select-pane '\\;' send-keys -X -N 3 scroll-down >/dev/null 2>&1 || true; ` +
    `printf '\\033]9991;%s\\007' "$MIDE_S"; ` +
    `exec tmux -u attach-session -d -t "$MIDE_S"; ` +
    `else ${cdCmd}exec \${SHELL:-/bin/bash} -l; fi`
  )
}

/**
 * Manages local & SSH terminals with coordinated, cmux-style disconnect/reconnect:
 * - Separates SSH transport (`ControlMaster`) recovery from individual pane re-attach so multiple
 *   tabs/splits on the same host share ONE end-to-end verified ControlMaster handshake (zero thundering herd!).
 * - Never resets reconnect backoff on a stale local mux socket — only resets after real stable uptime.
 * - Detects tmux client detaches (`[detached ...]`) to prevent ping-pong detach/reconnect fights.
 * - Runs a periodic end-to-end SSH health check to detect silent half-open ProxyCommand/VPN drops.
 */
export class TerminalManager {
  private sessions = new Map<string, ManagedTerminal>()
  private counter = 0
  private healthTimer: NodeJS.Timeout | null = null
  private healthChecking = false
  private envHealthFailures = new Map<string, number>()
  private resumeLock: Promise<void> | null = null
  private lastResumeAt = 0

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
      recentOutputTail: '',
      tmuxSession,
      attachRecentPending,
      awaitingTmuxAttach: attachRecentPending,
      awaitingInteractiveAuth: false,
      tmuxAttachWaiters: [],
      state: env.kind === 'local' ? 'connected' : 'connecting',
      closedByUser: false,
      reconnectPaused: false,
      reconnectAttempt: 0,
      reconnectTimer: null,
      sshCheckTimer: null,
      stableTimer: null,
      postAttachResizeTimers: [],
      lastSpawnAt: 0,
      isReattach: Boolean(explicitTmux),
      spawnGeneration: 0
    }

    this.sessions.set(id, managed)
    if (env.kind === 'ssh') {
      this.ensureHealthMonitor()
    }
    void this.prepareAndSpawnPty(managed).catch((err) => {
      if (managed.closedByUser) return
      managed.state = 'disconnected'
      this.events.onData(managed.info.id, `\r\n\x1b[31mFailed to initialize terminal: ${err?.message || err}\x1b[0m\r\n`)
      this.emitStatus(managed, { message: err?.message || 'Failed to initialize terminal' })
    })
    return info
  }

  private resolveTmuxAttachWaiters(managed: ManagedTerminal): void {
    managed.awaitingTmuxAttach = false
    if (managed.tmuxAttachWaiters.length === 0) return
    const waiters = managed.tmuxAttachWaiters.splice(0, managed.tmuxAttachWaiters.length)
    for (const fn of waiters) fn()
  }

  private clearPaneTimers(managed: ManagedTerminal): void {
    if (managed.reconnectTimer) {
      clearTimeout(managed.reconnectTimer)
      managed.reconnectTimer = null
    }
    if (managed.sshCheckTimer) {
      clearInterval(managed.sshCheckTimer)
      managed.sshCheckTimer = null
    }
    if (managed.stableTimer) {
      clearTimeout(managed.stableTimer)
      managed.stableTimer = null
    }
    for (const t of managed.postAttachResizeTimers) clearTimeout(t)
    managed.postAttachResizeTimers = []
  }

  private waitForPendingTmuxAttaches(envId: string, timeoutMs = 6000): Promise<void> {
    const pending = Array.from(this.sessions.values()).filter(
      (s) => s.env.id === envId && s.awaitingTmuxAttach && !s.closedByUser
    )
    if (pending.length === 0) return Promise.resolve()

    const allDone = Promise.all(
      pending.map(
        (s) =>
          new Promise<void>((resolve) => {
            if (!s.awaitingTmuxAttach || s.closedByUser) {
              resolve()
              return
            }
            s.tmuxAttachWaiters.push(resolve)
          })
      )
    ).then(() => undefined)

    return Promise.race([allDone, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))])
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

  private async probeAllTmuxSessions(env: Environment): Promise<RecoverableTmuxSession[]> {
    const probeCmd =
      `if command -v tmux >/dev/null 2>&1; then ` +
      `printf '__NOW__:%s\\n' "$(date +%s)"; ` +
      `tmux list-sessions -F '#{session_name}\t#{session_activity}\t#{session_attached}\t#{pane_current_command}\t#{pane_current_path}\t#{session_windows}\t#{window_width}x#{window_height}' 2>/dev/null || true; ` +
      `fi`
    try {
      const res = await this.controlMaster.exec(env, probeCmd, { timeoutMs: 5000, reuseOnly: true })
      const owned = this.getOwnedTmuxSessions(env.id)
      return parseTmuxSessionsOutput(res.stdout, owned)
    } catch {
      return []
    }
  }

  /**
   * Lists ALL live remote tmux sessions on `env` (for the interactive pane switcher & saved-tab recovery).
   */
  async listTmuxSessions(env: Environment): Promise<RecoverableTmuxSession[]> {
    if (env.kind !== 'ssh') return []
    const connected = await this.controlMaster.isConnected(env)
    if (!connected) return []
    const all = await this.probeAllTmuxSessions(env)
    return all.sort((a, b) => {
      if (Boolean(a.ownedByApp) !== Boolean(b.ownedByApp)) return a.ownedByApp ? -1 : 1
      const aActive = !isIdleShellCommand(a.command)
      const bActive = !isIdleShellCommand(b.command)
      if (aActive !== bActive) return aActive ? -1 : 1
      return a.ageSec - b.ageSec
    })
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

    // Wait cleanly for any in-flight `attachRecentPending` pane to confirm OSC 9991 (or exit)
    await this.waitForPendingTmuxAttaches(env.id, 6000)

    const probeCmd =
      `if command -v tmux >/dev/null 2>&1; then ` +
      `printf '__NOW__:%s\\n' "$(date +%s)"; ` +
      `tmux list-sessions -F '#{session_name}\t#{session_activity}\t#{session_attached}\t#{pane_current_command}\t#{pane_current_path}\t#{session_windows}\t#{window_width}x#{window_height}' 2>/dev/null || true; ` +
      `fi`

    try {
      const res = await this.controlMaster.exec(env, probeCmd, { timeoutMs: 5000, reuseOnly: true })
      const owned = this.getOwnedTmuxSessions(env.id)
      return parseRecoverableTmuxOutput(res.stdout, maxAgeSec, owned).slice(0, 6)
    } catch {
      return []
    }
  }

  /**
   * Switches an SSH terminal pane IN-PLACE to a specific remote tmux session (or a brand-new
   * clean `mide_*` session when `targetSession` is omitted / `'__new__'`), avoiding nested `tmux a`!
   * If another pane in this app currently holds `targetSession`, pauses that pane cleanly so `-d`
   * never triggers a ping-pong reconnect fight!
   */
  async switchTmuxSession(terminalId: string, targetSession?: string): Promise<string | undefined> {
    const managed = this.sessions.get(terminalId)
    if (!managed || managed.closedByUser || managed.env.kind !== 'ssh') return undefined

    const isFresh = !targetSession || targetSession === '__new__'
    const nextSession = isFresh
      ? `mide_${++this.counter}_${Date.now().toString(36).slice(-4)}`
      : targetSession.trim()

    if (!nextSession || !/^[a-zA-Z0-9_.-]+$/.test(nextSession)) {
      return managed.tmuxSession
    }

    // Prevent ping-pong detach loop if another open pane in this IDE owns the same tmux session
    if (!isFresh) {
      for (const [otherId, other] of this.sessions) {
        if (otherId !== terminalId && other.env.id === managed.env.id && other.tmuxSession === nextSession) {
          this.pauseReconnect(otherId)
        }
      }
    }

    managed.attachRecentPending = false
    this.resolveTmuxAttachWaiters(managed)
    managed.tmuxSession = nextSession
    managed.info.tmuxSession = nextSession
    managed.options.useTmux = true
    managed.options.tmuxSession = nextSession
    managed.isReattach = !isFresh

    this.events.onData(
      managed.info.id,
      `\r\n\x1b[36m─── Switching pane to tmux session ${nextSession}${isFresh ? ' (new)' : ''}... ───\x1b[0m\r\n`
    )
    await this.reconnect(terminalId, { forceReset: false })
    return nextSession
  }

  /**
   * Kills a specific remote tmux session (refusing to kill a session actively owned by a live pane).
   */
  async killTmuxSession(env: Environment, sessionName: string): Promise<boolean> {
    if (env.kind !== 'ssh' || !sessionName || !/^[a-zA-Z0-9_.-]+$/.test(sessionName)) return false
    const owned = this.getOwnedTmuxSessions(env.id)
    if (owned.has(sessionName)) return false
    try {
      const res = await this.controlMaster.exec(
        env,
        `tmux kill-session -t ${shellQuote(sessionName)} 2>/dev/null`,
        { timeoutMs: 4000, reuseOnly: true }
      )
      return res.code === 0
    } catch {
      return false
    }
  }

  /**
   * Cleans up unattached, unowned `mide_*` sessions idle longer than `minAgeSec` (default: 1 hour).
   */
  async pruneStaleTmuxSessions(env: Environment, minAgeSec = DEFAULT_RECENT_TMUX_MAX_AGE_SEC): Promise<number> {
    if (env.kind !== 'ssh') return 0
    const all = await this.probeAllTmuxSessions(env)
    const stale = all.filter(
      (s) => s.isManaged && !s.ownedByApp && s.attached === 0 && s.ageSec >= minAgeSec
    )
    if (stale.length === 0) return 0

    const killCmd = stale.map((s) => `tmux kill-session -t ${shellQuote(s.name)} 2>/dev/null || true`).join('; ')
    try {
      await this.controlMaster.exec(env, killCmd, { timeoutMs: 5000, reuseOnly: true })
      return stale.length
    } catch {
      return 0
    }
  }

  private ensureHealthMonitor(): void {
    if (this.healthTimer) return
    this.healthTimer = setInterval(() => {
      void this.runHealthCheck()
    }, HEALTH_CHECK_INTERVAL_MS)
  }

  private stopHealthMonitorIfIdle(): void {
    const hasSsh = Array.from(this.sessions.values()).some((s) => s.env.kind === 'ssh' && !s.closedByUser)
    if (!hasSsh && this.healthTimer) {
      clearInterval(this.healthTimer)
      this.healthTimer = null
      this.envHealthFailures.clear()
    }
  }

  private async runHealthCheck(): Promise<void> {
    if (this.healthChecking) return
    this.healthChecking = true
    try {
      const now = Date.now()
      const connectedByEnv = new Map<string, ManagedTerminal[]>()
      const busyEnvs = new Set<string>()

      for (const sess of this.sessions.values()) {
        if (sess.env.kind !== 'ssh' || sess.closedByUser) continue
        if (sess.state === 'reconnecting' || sess.state === 'connecting' || sess.awaitingInteractiveAuth) {
          busyEnvs.add(sess.env.id)
          continue
        }
        if (!sess.reconnectPaused && sess.state === 'connected' && now - sess.lastSpawnAt > 15_000) {
          const list = connectedByEnv.get(sess.env.id) || []
          list.push(sess)
          connectedByEnv.set(sess.env.id, list)
        }
      }

      for (const [envId, panes] of connectedByEnv) {
        if (busyEnvs.has(envId)) continue
        const env = panes[0].env
        const healthy = await this.controlMaster.verifyEndToEnd(env, 4500)
        if (healthy) {
          this.envHealthFailures.delete(envId)
          continue
        }
        const fails = (this.envHealthFailures.get(envId) || 0) + 1
        this.envHealthFailures.set(envId, fails)
        if (fails >= 2) {
          this.envHealthFailures.delete(envId)
          this.events.onSshDisconnected?.(envId)
          // Tear down the half-open master ONCE, then let coordinated reconnect bring all panes back
          await this.controlMaster.resetControlSocket(env, { force: true }).catch(() => {})
          for (let i = 0; i < panes.length; i++) {
            const p = panes[i]
            if (p.closedByUser || p.reconnectPaused || p.state !== 'connected') continue
            if (i > 0) await new Promise((r) => setTimeout(r, 200))
            void this.reconnect(p.info.id, { forceReset: false })
          }
        }
      }
    } finally {
      this.healthChecking = false
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

  /**
   * Forces OpenSSH to transmit a fresh `window-change` (SIGWINCH) right after `tmux attach-session -d`
   * starts, eliminating the classic race where xterm.js fitted during SSH handshake and tmux attached
   * with stale dimensions (causing wrapped borders & misaligned cursor/input!).
   */
  private schedulePostAttachSizeSync(managed: ManagedTerminal, ptyProcess: pty.IPty): void {
    for (const t of managed.postAttachResizeTimers) clearTimeout(t)
    managed.postAttachResizeTimers = []
    const t1 = setTimeout(() => {
      if (managed.closedByUser || managed.ptyProcess !== ptyProcess) return
      const cols = managed.info.cols
      const rows = managed.info.rows
      if (cols < 12 || rows < 4) return
      try {
        // Kernel TIOCSWINSZ is a no-op if size is unchanged; a 35ms 1-col nudge guarantees
        // OpenSSH sends a real `window-change` packet to remote tmux!
        ptyProcess.resize(cols - 1, rows)
      } catch {
        return
      }
      const t2 = setTimeout(() => {
        if (managed.closedByUser || managed.ptyProcess !== ptyProcess) return
        try {
          ptyProcess.resize(managed.info.cols, managed.info.rows)
        } catch {
          // ignore
        }
      }, 35)
      managed.postAttachResizeTimers.push(t2)
    }, 160)
    managed.postAttachResizeTimers.push(t1)
  }

  private spawnPty(managed: ManagedTerminal): void {
    if (managed.closedByUser) return
    this.clearPaneTimers(managed)

    const { env, options } = managed
    const spawnGen = managed.spawnGeneration
    const cols = managed.info.cols || 100
    const rows = managed.info.rows || 30
    managed.recentOutputTail = ''

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

    ensureNodePtySpawnHelperExecutable()

    const enrichedEnv = buildEnrichedEnv()
    const ptyEnv = sanitizePtyEnv({
      ...enrichedEnv,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: process.env.LANG || 'en_US.UTF-8',
      MULTIPLEX_IDE: '1',
      MULTIPLEX_ENV_ID: env.id
    })

    let ptyProcess: pty.IPty | null = null
    let spawnErr: unknown = null
    try {
      ptyProcess = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: ptyEnv
      })
    } catch (err) {
      spawnErr = err
      if (env.kind === 'local') {
        for (const [fallbackShell, fallbackArgs] of [
          ['/bin/zsh', ['-l']],
          ['/bin/sh', []]
        ] as Array<[string, string[]]>) {
          try {
            ptyProcess = pty.spawn(fallbackShell, fallbackArgs, {
              name: 'xterm-256color',
              cols,
              rows,
              cwd: os.homedir(),
              env: ptyEnv
            })
            spawnErr = null
            break
          } catch (fallbackErr) {
            spawnErr = fallbackErr
          }
        }
      }
    }

    if (!ptyProcess) {
      const errMsg = (spawnErr as Error)?.message || String(spawnErr || 'Failed to spawn PTY')
      this.resolveTmuxAttachWaiters(managed)
      managed.state = 'disconnected'
      this.events.onData(
        managed.info.id,
        `\r\n\x1b[31mFailed to spawn ${env.kind === 'local' ? 'local shell' : 'SSH'} PTY: ${errMsg}\x1b[0m\r\n` +
          `\x1b[90m─── Press Enter to retry ───\x1b[0m\r\n`
      )
      this.emitStatus(managed, { message: errMsg })
      return
    }

    managed.ptyProcess = ptyProcess
    // Apply latest terminal dimensions if UI fitted while preparing PTY
    if (managed.info.cols !== cols || managed.info.rows !== rows) {
      try {
        ptyProcess.resize(managed.info.cols, managed.info.rows)
      } catch {
        // ignore
      }
    }

    // ONLY reset backoff counter after the PTY genuinely stays alive and healthy for 10 seconds!
    // (Never reset inside checkReady, which could see a stale local mux socket and cause infinite 1/N loops!)
    if (env.kind === 'ssh') {
      managed.stableTimer = setTimeout(() => {
        if (managed.closedByUser || managed.ptyProcess !== ptyProcess) return
        managed.reconnectAttempt = 0
        managed.awaitingInteractiveAuth = false
      }, STABLE_CONNECTION_RESET_MS)
    }

    let notifiedSshReady = env.kind === 'local'
    let receivedRemoteData = false
    let checking = false
    const markSshPaneConnected = () => {
      if (notifiedSshReady || managed.closedByUser || managed.ptyProcess !== ptyProcess) return
      notifiedSshReady = true
      this.envHealthFailures.delete(env.id)
      managed.state = 'connected'
      managed.awaitingInteractiveAuth = false
      this.emitStatus(managed)
      this.events.onSshConnected(env.id)
    }

    const checkReady = async () => {
      if (notifiedSshReady || checking || managed.closedByUser || managed.ptyProcess !== ptyProcess) return
      // Require either tmux OSC 9991 confirmation OR actual remote output + >800ms uptime before marking connected
      // so a fast-failing channel on a stale mux socket never flashes false "connected"!
      if (!receivedRemoteData && Date.now() - managed.lastSpawnAt < 1800) return
      checking = true
      try {
        if (await this.controlMaster.isConnected(env)) {
          markSshPaneConnected()
        }
      } finally {
        checking = false
      }
    }

    if (env.kind === 'ssh') {
      managed.sshCheckTimer = setInterval(checkReady, 2000)
    }

    ptyProcess.onData((rawData) => {
      if (managed.ptyProcess !== ptyProcess) return
      receivedRemoteData = true
      // Strip ESC[3J on SSH sessions so tmux re-attach never wipes local scrollback
      let data = env.kind === 'ssh' ? stripEraseScrollback(rawData) : rawData

      // Keep small rolling tail for detecting intentional `[detached (from session ...)]`
      managed.recentOutputTail = (managed.recentOutputTail + data).slice(-512)

      // Parse hidden OSC 9991 marker emitted right before `exec tmux -u attach-session -d`
      // so we record the exact remote tmux session name & sync PTY dimensions cleanly!
      if (env.kind === 'ssh' && data.includes('\x1b]9991;')) {
        const { cleaned, sessionName } = extractMideTmuxMarker(data)
        data = cleaned
        if (sessionName) {
          const wasAutoRecovered = managed.attachRecentPending && sessionName !== managed.tmuxSession
          managed.tmuxSession = sessionName
          managed.info.tmuxSession = sessionName
          managed.attachRecentPending = false
          this.resolveTmuxAttachWaiters(managed)
          this.schedulePostAttachSizeSync(managed, ptyProcess)
          markSshPaneConnected()
          if (wasAutoRecovered) {
            this.emitStatus(managed, {
              message: `Reattached active tmux session (${sessionName}) on ${env.name}`
            })
          }
        }
      }

      if (data) {
        this.events.onData(managed.info.id, data)
      }

      if (env.kind === 'ssh' && managed.state !== 'connected' && Date.now() - managed.lastSpawnAt > 800) {
        void checkReady()
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
      // Ignore exit from an older PTY replaced by manual reconnect() / switchTmuxSession()
      if (managed.ptyProcess !== ptyProcess) return
      this.clearPaneTimers(managed)
      this.resolveTmuxAttachWaiters(managed)
      managed.ptyProcess = null

      if (managed.closedByUser) {
        this.sessions.delete(managed.info.id)
        this.stopHealthMonitorIfIdle()
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
      const detachedByTmux = isTmuxDetachOutput(managed.recentOutputTail)
      void this.handleSshPtyExit(managed, spawnGen, exitCode, livedMs, detachedByTmux)
    })
  }

  private async handleSshPtyExit(
    managed: ManagedTerminal,
    spawnGen: number,
    exitCode: number,
    livedMs: number,
    detachedByTmux: boolean
  ): Promise<void> {
    // Verify REAL end-to-end reachability (not just local mux PID!) so a wedged/half-open
    // ControlMaster is detected immediately and NEVER misclassified as healthy or clean exit!
    const masterHealthy = await this.controlMaster.verifyEndToEnd(managed.env, 3500).catch(() => false)

    // Guard against concurrent reconnect() / close() while awaiting health probe
    if (managed.closedByUser || managed.spawnGeneration !== spawnGen || managed.ptyProcess !== null) {
      return
    }

    if (!masterHealthy) {
      this.events.onSshDisconnected?.(managed.env.id)
    }

    if (managed.reconnectPaused) {
      managed.state = 'disconnected'
      this.emitStatus(managed, { exitCode, message: 'Reconnect paused — press Enter or ↻' })
      return
    }

    // Intentional tmux detach (`C-b d`) or another pane took over this tmux session with `-d`:
    // NEVER auto-reconnect in a loop or the two panes will ping-pong detach each other!
    if (masterHealthy && detachedByTmux && exitCode === 0) {
      managed.state = 'disconnected'
      this.events.onData(
        managed.info.id,
        `\r\n\x1b[90m─── Detached from tmux session${managed.tmuxSession ? ` (${managed.tmuxSession})` : ''}. Press Enter or click ↻ to re-attach ───\x1b[0m\r\n`
      )
      this.emitStatus(managed, { exitCode, message: 'Detached — press Enter or ↻ to re-attach' })
      return
    }

    // Clean shell exit (`exit` / Ctrl-D) while SSH transport is genuinely healthy
    if (masterHealthy && exitCode === 0 && livedMs > 3000) {
      managed.state = 'disconnected'
      this.events.onData(
        managed.info.id,
        `\r\n\x1b[90m─── Session ended (exit ${exitCode}). Press Enter or click ↻ to reconnect ───\x1b[0m\r\n`
      )
      this.emitStatus(managed, { exitCode, message: 'Session ended — press Enter or ↻' })
      return
    }

    // Interactive password/2FA prompt ended without authenticating: let user retry manually
    if (managed.awaitingInteractiveAuth) {
      managed.awaitingInteractiveAuth = false
      managed.state = 'disconnected'
      this.events.onData(
        managed.info.id,
        `\r\n\x1b[33m─── Interactive authentication ended. Press Enter or click ↻ to retry ───\x1b[0m\r\n`
      )
      this.emitStatus(managed, { exitCode, message: 'Auth required — press Enter or ↻ to retry' })
      return
    }

    // Abnormal disconnect or fast channel failure: force master teardown when transport failed OR exited fast (<5s)
    const forceMasterReset = !masterHealthy || livedMs < 5000
    this.scheduleAutoReconnect(managed, exitCode, { forceMasterReset })
  }

  private scheduleAutoReconnect(
    managed: ManagedTerminal,
    exitCode?: number,
    opts?: { forceMasterReset?: boolean; lastError?: string }
  ): void {
    if (managed.closedByUser || managed.reconnectPaused) return
    const attempt = managed.reconnectAttempt + 1
    const maxAttempts = RECONNECT_BACKOFF_MS.length

    if (attempt > maxAttempts) {
      managed.state = 'disconnected'
      const reason = opts?.lastError ? ` (${summarizeSshError(opts.lastError)})` : ''
      this.events.onData(
        managed.info.id,
        `\r\n\x1b[31m─── Disconnected from ${managed.env.name}${reason}. Press Enter, Space, or click ↻ to reconnect ───\x1b[0m\r\n`
      )
      this.emitStatus(managed, {
        exitCode,
        attempt: maxAttempts,
        maxAttempts,
        message: opts?.lastError
          ? `${summarizeSshError(opts.lastError)} — click ↻ to retry`
          : 'Auto-reconnect paused — press Enter or click ↻'
      })
      return
    }

    managed.reconnectAttempt = attempt
    const baseDelay = RECONNECT_BACKOFF_MS[attempt - 1]
    // Jitter helps multiple panes settle cleanly onto the single shared ControlMaster promise
    const jitter = Math.floor(Math.random() * 400)
    const delayMs = baseDelay + jitter
    managed.state = 'reconnecting'
    const reason = opts?.lastError
      ? summarizeSshError(opts.lastError)
      : `code ${exitCode ?? '?'}`
    this.events.onData(
      managed.info.id,
      `\r\n\x1b[33m─── Connection lost (${reason}). Reconnecting to ${managed.env.name} in ${(baseDelay / 1000).toFixed(1)}s (${attempt}/${maxAttempts})... ───\x1b[0m\r\n`
    )
    this.emitStatus(managed, {
      exitCode,
      attempt,
      maxAttempts,
      nextRetryMs: delayMs,
      message: `Reconnecting (${attempt}/${maxAttempts})...`
    })

    const scheduledGen = managed.spawnGeneration
    const shouldForceMasterReset = Boolean(opts?.forceMasterReset || attempt >= 2)
    managed.reconnectTimer = setTimeout(async () => {
      managed.reconnectTimer = null
      if (managed.closedByUser || managed.reconnectPaused || managed.spawnGeneration !== scheduledGen) return

      // Coordinate ONE shared end-to-end healthy ControlMaster per host BEFORE spawning any pane PTY!
      // `allowReuseRecentMs: 8000` guarantees a lagging sibling tab reuses a fresh master just established
      // by another tab instead of tearing it down!
      const masterRes = await this.controlMaster
        .ensureHealthyMaster(managed.env, {
          forceReset: shouldForceMasterReset,
          allowReuseRecentMs: 8000
        })
        .catch((err) => ({ ok: false as const, error: String(err?.message || err) }))

      if (managed.closedByUser || managed.reconnectPaused || managed.spawnGeneration !== scheduledGen) return

      if (masterRes.ok) {
        this.envHealthFailures.delete(managed.env.id)
        this.events.onSshConnected(managed.env.id)
        managed.isReattach = true
        this.spawnPty(managed)
        return
      }

      if ('nonRetryable' in masterRes && masterRes.nonRetryable) {
        const msg = summarizeSshError(masterRes.error)
        managed.state = 'disconnected'
        this.events.onData(
          managed.info.id,
          `\r\n\x1b[31m─── SSH error: ${msg}. Fix SSH config/keys then click ↻ to reconnect ───\x1b[0m\r\n`
        )
        this.emitStatus(managed, { message: msg })
        return
      }

      if ('needsInteractiveAuth' in masterRes && masterRes.needsInteractiveAuth) {
        // Spawn ONE interactive SSH PTY so the user can enter password / 2FA without auto-looping
        managed.awaitingInteractiveAuth = true
        managed.isReattach = true
        this.events.onData(
          managed.info.id,
          `\r\n\x1b[36m─── Interactive SSH authentication required for ${managed.env.name}... ───\x1b[0m\r\n`
        )
        this.spawnPty(managed)
        return
      }

      // Transport still unavailable (VPN/Wi-Fi/gateway down): back off cleanly WITHOUT spawning doomed PTYs!
      this.scheduleAutoReconnect(managed, exitCode, {
        forceMasterReset: true,
        lastError: masterRes.error
      })
    }, delayMs)
  }

  /**
   * Pauses automatic reconnect retries on a pane (preserving scrollback) until user manually reconnects.
   */
  pauseReconnect(terminalId: string): void {
    const managed = this.sessions.get(terminalId)
    if (!managed || managed.closedByUser) return
    managed.reconnectPaused = true
    managed.awaitingInteractiveAuth = false
    managed.spawnGeneration++
    this.resolveTmuxAttachWaiters(managed)
    this.clearPaneTimers(managed)
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
   * When `forceReset` is true (e.g. user clicked "Reconnect Now"), genuinely tears down any wedged
   * ControlMaster (including hung mux PIDs) and establishes ONE fresh end-to-end verified master first!
   */
  async reconnect(terminalId: string, opts?: { forceReset?: boolean; env?: Environment }): Promise<void> {
    const managed = this.sessions.get(terminalId)
    if (!managed || managed.closedByUser) return

    if (opts?.env) {
      managed.env = opts.env
    }

    managed.reconnectPaused = false
    managed.awaitingInteractiveAuth = false
    const gen = ++managed.spawnGeneration
    this.resolveTmuxAttachWaiters(managed)
    this.clearPaneTimers(managed)

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
      const masterRes = await this.controlMaster
        .ensureHealthyMaster(managed.env, { forceReset: Boolean(opts?.forceReset) })
        .catch((err) => ({ ok: false as const, error: String(err?.message || err) }))

      if (managed.closedByUser || managed.reconnectPaused || managed.spawnGeneration !== gen) return

      if (masterRes.ok) {
        this.envHealthFailures.delete(managed.env.id)
        this.events.onSshConnected(managed.env.id)
        this.spawnPty(managed)
        return
      }

      if ('nonRetryable' in masterRes && masterRes.nonRetryable) {
        const msg = summarizeSshError(masterRes.error)
        managed.state = 'disconnected'
        this.events.onData(managed.info.id, `\r\n\x1b[31m─── SSH error: ${msg} ───\x1b[0m\r\n`)
        this.emitStatus(managed, { message: msg })
        return
      }

      if ('needsInteractiveAuth' in masterRes && masterRes.needsInteractiveAuth) {
        managed.awaitingInteractiveAuth = true
        this.spawnPty(managed)
        return
      }

      // Fresh dial failed — enter smooth progressive backoff with the real error displayed
      this.scheduleAutoReconnect(managed, 255, {
        forceMasterReset: true,
        lastError: masterRes.error
      })
      return
    }

    if (!managed.closedByUser && !managed.reconnectPaused && managed.spawnGeneration === gen) {
      this.spawnPty(managed)
    }
  }

  /**
   * Called on macOS `powerMonitor.on('resume')` (wake from sleep), network `'online'` event,
   * or user "Reconnect All" click to recover disconnected/stale SSH panes cleanly per environment.
   * Verifies REAL end-to-end health, establishes ONE fresh ControlMaster per env, then re-attaches panes!
   */
  async handleSystemResume(opts?: { force?: boolean }): Promise<void> {
    if (this.resumeLock) {
      return this.resumeLock
    }
    if (!opts?.force && Date.now() - this.lastResumeAt < 3500) {
      return
    }

    this.lastResumeAt = Date.now()
    const task = (async () => {
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
          const healthy = await this.controlMaster.verifyEndToEnd(env, 4000).catch(() => false)
          const targets = healthy
            ? panes.filter((p) => p.state === 'disconnected' || p.state === 'reconnecting')
            : panes
          if (targets.length === 0) return

          if (!healthy) {
            await this.controlMaster.resetControlSocket(env, { force: true }).catch(() => {})
          }
          // Pre-warm ONE shared healthy ControlMaster for this env before staggering pane re-attaches
          const masterRes = await this.controlMaster
            .ensureHealthyMaster(env, { forceReset: !healthy })
            .catch((err) => ({ ok: false as const, error: String(err?.message || err) }))

          for (let i = 0; i < targets.length; i++) {
            const p = targets[i]
            if (p.closedByUser || p.reconnectPaused) continue
            if (masterRes.ok) {
              if (i > 0) await new Promise((r) => setTimeout(r, 180))
              void this.reconnect(p.info.id, { forceReset: false })
            } else if ('needsInteractiveAuth' in masterRes && masterRes.needsInteractiveAuth) {
              if (i === 0) void this.reconnect(p.info.id, { forceReset: false })
            } else {
              // Network/VPN not ready yet — hand off cleanly to progressive backoff (no burst!)
              p.reconnectAttempt = 0
              this.scheduleAutoReconnect(p, 255, { forceMasterReset: true, lastError: masterRes.error })
            }
          }
        })
      )
    })()

    this.resumeLock = task
    try {
      await task
    } finally {
      if (this.resumeLock === task) {
        this.resumeLock = null
      }
    }
  }

  /** Marks all SSH panes for an env as disconnected (preserving their panes & scrollback!) */
  disconnectEnv(envId: string): void {
    this.envHealthFailures.delete(envId)
    for (const managed of this.sessions.values()) {
      if (managed.env.id !== envId || managed.env.kind !== 'ssh') continue
      managed.spawnGeneration++
      managed.awaitingInteractiveAuth = false
      this.resolveTmuxAttachWaiters(managed)
      this.clearPaneTimers(managed)
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
    } else if (managed.state !== 'reconnecting' && (data === '\r' || data === '\n' || data === ' ')) {
      // Pressing Enter or Space in a disconnected pane immediately triggers in-place reconnect/respawn!
      void this.reconnect(terminalId, { forceReset: managed.env.kind === 'ssh' })
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
    sess.spawnGeneration++
    this.resolveTmuxAttachWaiters(sess)
    this.clearPaneTimers(sess)
    this.sessions.delete(terminalId)
    this.stopHealthMonitorIfIdle()

    try {
      sess.ptyProcess?.kill()
    } catch {
      // ignore
    }

    // Only destroy MultiplexIDE-managed (`mide_*`) sessions when user intentionally closes a pane;
    // NEVER destroy personal/custom tmux sessions the user manually switched into, or on app quit!
    if (
      opts?.destroyRemoteSession !== false &&
      sess.env.kind === 'ssh' &&
      sess.tmuxSession &&
      sess.tmuxSession.startsWith('mide_')
    ) {
      void this.controlMaster
        .exec(sess.env, `tmux kill-session -t ${shellQuote(sess.tmuxSession)} 2>/dev/null || true`, {
          timeoutMs: 3000,
          reuseOnly: true
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
    if (this.healthTimer) {
      clearInterval(this.healthTimer)
      this.healthTimer = null
    }
    for (const id of Array.from(this.sessions.keys())) {
      // On app quit, detach without killing remote tmux sessions so work survives app restarts too!
      this.kill(id, { destroyRemoteSession: false })
    }
  }
}
