import os from 'os'
import * as pty from 'node-pty'
import type { Environment, TerminalCreateOptions, TerminalNotification, TerminalSessionInfo } from '@shared/types'
import type { SshControlMaster } from '../ssh/controlMaster'

interface ManagedTerminal {
  info: TerminalSessionInfo
  ptyProcess: pty.IPty
  env: Environment
  oscBuffer: string
}

export interface TerminalEvents {
  onData: (terminalId: string, data: string) => void
  onExit: (terminalId: string, envId: string, exitCode: number) => void
  onNotification: (notification: TerminalNotification) => void
  onSshConnected: (envId: string) => void
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

/** Builds safe remote cd expression that expands leading ~/ to "$HOME/" cleanly in POSIX sh */
function remoteCdSnippet(targetDir?: string): string {
  if (!targetDir || targetDir === '~') return ''
  if (targetDir.startsWith('~/')) {
    const rel = targetDir.slice(2)
    return `cd "$HOME"/${shellQuote(rel)} 2>/dev/null || cd "$HOME" 2>/dev/null || true; `
  }
  return `cd ${shellQuote(targetDir)} 2>/dev/null || true; `
}

export class TerminalManager {
  private sessions = new Map<string, ManagedTerminal>()
  private counter = 0

  constructor(
    private controlMaster: SshControlMaster,
    private events: TerminalEvents
  ) {}

  create(env: Environment, options: TerminalCreateOptions): TerminalSessionInfo {
    const id = `term-${++this.counter}-${Date.now().toString(36)}`
    const cols = options.cols || 100
    const rows = options.rows || 30
    const useTmux = options.useTmux ?? env.useTmux

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

      if (useTmux) {
        const sessName = (env.tmuxSessionName || 'multiplex').replace(/[^a-zA-Z0-9_-]/g, '_')
        const remoteCmd = `${cdCmd}if command -v tmux >/dev/null 2>&1; then exec tmux new-session -A -s ${shellQuote(sessName)}; else exec \${SHELL:-/bin/bash} -l; fi`
        args = [...baseArgs, '-t', dest, remoteCmd]
      } else if (cdCmd) {
        const remoteCmd = `${cdCmd}exec \${SHELL:-/bin/bash} -l`
        args = [...baseArgs, '-t', dest, remoteCmd]
      } else {
        args = [...baseArgs, dest]
      }
    }

    const ptyProcess = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        LANG: process.env.LANG || 'en_US.UTF-8',
        MULTIPLEX_IDE: '1',
        MULTIPLEX_ENV_ID: env.id
      }
    })

    const info: TerminalSessionInfo = {
      id,
      envId: env.id,
      title: options.title || (env.kind === 'local' ? 'zsh' : env.name),
      cwd: options.cwd || env.defaultPath,
      cols,
      rows,
      createdAt: Date.now()
    }

    const managed: ManagedTerminal = { info, ptyProcess, env, oscBuffer: '' }
    this.sessions.set(id, managed)

    let notifiedSshReady = env.kind === 'local'
    let checking = false
    const checkReady = async () => {
      if (notifiedSshReady || checking || !this.sessions.has(id)) return
      checking = true
      try {
        if (await this.controlMaster.isConnected(env)) {
          notifiedSshReady = true
          this.events.onSshConnected(env.id)
        }
      } finally {
        checking = false
      }
    }

    const sshCheckTimer = env.kind === 'ssh' ? setInterval(checkReady, 2000) : null

    ptyProcess.onData((data) => {
      this.events.onData(id, data)
      if (!notifiedSshReady) void checkReady()

      if (data.includes('\x1b]')) {
        const combined = (managed.oscBuffer + data).slice(-4096)
        const notifications = parseOscNotifications(combined)
        for (const n of notifications) {
          this.events.onNotification({
            terminalId: id,
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
      if (sshCheckTimer) clearInterval(sshCheckTimer)
      this.sessions.delete(id)
      this.events.onExit(id, env.id, exitCode)
    })

    return info
  }

  write(terminalId: string, data: string): void {
    this.sessions.get(terminalId)?.ptyProcess.write(data)
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const sess = this.sessions.get(terminalId)
    if (!sess) return
    const safeCols = Math.max(10, Math.min(500, Math.floor(cols)))
    const safeRows = Math.max(4, Math.min(200, Math.floor(rows)))
    try {
      sess.ptyProcess.resize(safeCols, safeRows)
      sess.info.cols = safeCols
      sess.info.rows = safeRows
    } catch {
      // ignore
    }
  }

  kill(terminalId: string): void {
    const sess = this.sessions.get(terminalId)
    if (!sess) return
    this.sessions.delete(terminalId)
    try {
      sess.ptyProcess.kill()
    } catch {
      // ignore
    }
  }

  killAllForEnv(envId: string): void {
    for (const [id, sess] of this.sessions) {
      if (sess.info.envId === envId) {
        this.kill(id)
      }
    }
  }

  killAll(): void {
    for (const id of Array.from(this.sessions.keys())) {
      this.kill(id)
    }
  }
}
