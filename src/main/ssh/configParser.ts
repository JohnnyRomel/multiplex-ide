import fs from 'fs'
import os from 'os'
import path from 'path'
import SSHConfig, { LineType } from 'ssh-config'
import type {
  CustomHostInput,
  EditorThemeId,
  Environment,
  MultiplexConfigFile,
  SshConfigHostSummary,
  WorkspaceConfigEntry
} from '@shared/types'

const ENV_PALETTE = [
  '#a6e22e',
  '#66d9ef',
  '#fd971f',
  '#f92672',
  '#ae81ff',
  '#e6db74'
]

export function pickColorForHost(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  }
  return ENV_PALETTE[hash % ENV_PALETTE.length]
}

export function expandLocalTilde(filePath: string): string {
  if (filePath === '~') return os.homedir()
  if (filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2))
  }
  return filePath
}

function resolveIncludeFiles(pattern: string, baseDir: string): string[] {
  const expanded = expandLocalTilde(pattern)
  const fullPattern = path.isAbsolute(expanded) ? expanded : path.join(baseDir, expanded)

  if (!fullPattern.includes('*') && !fullPattern.includes('?')) {
    return fs.existsSync(fullPattern) && fs.statSync(fullPattern).isFile() ? [fullPattern] : []
  }

  const dir = path.dirname(fullPattern)
  const filePattern = path.basename(fullPattern)
  if (!fs.existsSync(dir)) return []

  const regexStr =
    '^' + filePattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
  const regex = new RegExp(regexStr)

  try {
    return fs
      .readdirSync(dir)
      .filter((entry) => regex.test(entry))
      .map((entry) => path.join(dir, entry))
      .filter((p) => {
        try {
          return fs.statSync(p).isFile()
        } catch {
          return false
        }
      })
      .sort()
  } catch {
    return []
  }
}

export function parseSshConfigContent(
  content: string,
  baseDir: string = path.join(os.homedir(), '.ssh'),
  visited: Set<string> = new Set()
): SshConfigHostSummary[] {
  const config = SSHConfig.parse(content)
  const hostsMap = new Map<string, SshConfigHostSummary>()

  const getParam = (section: any, key: string): string | undefined => {
    if (!section?.config) return undefined
    for (const line of section.config) {
      if (line.type === LineType.DIRECTIVE && line.param?.toLowerCase() === key.toLowerCase()) {
        return Array.isArray(line.value) ? line.value[0] : String(line.value)
      }
    }
    return undefined
  }

  for (const line of config) {
    if (line.type === LineType.DIRECTIVE && line.param?.toLowerCase() === 'include') {
      const patterns = Array.isArray(line.value)
        ? line.value.map((v: any) => (typeof v === 'string' ? v : v.val))
        : String(line.value).split(/\s+/)
      for (const pat of patterns) {
        for (const incFile of resolveIncludeFiles(pat, baseDir)) {
          if (visited.has(incFile)) continue
          visited.add(incFile)
          try {
            const incContent = fs.readFileSync(incFile, 'utf8')
            for (const h of parseSshConfigContent(incContent, path.dirname(incFile), visited)) {
              if (!hostsMap.has(h.alias)) {
                hostsMap.set(h.alias, h)
              }
            }
          } catch {
            // ignore unreadable include
          }
        }
      }
    }
  }

  for (const section of config) {
    if (section.type === LineType.DIRECTIVE && section.param?.toLowerCase() === 'host') {
      const rawValues = Array.isArray(section.value)
        ? section.value.map((v: any) => (typeof v === 'string' ? v : v.val))
        : String(section.value).split(/\s+/)

      for (const alias of rawValues) {
        if (!alias || alias.includes('*') || alias.includes('?') || alias.startsWith('!')) {
          continue
        }
        if (hostsMap.has(alias)) continue

        const computed = config.compute(alias) as Record<string, string | string[] | undefined>
        const pick = (k: string): string | undefined => {
          const val = computed[k] ?? getParam(section, k)
          if (Array.isArray(val)) return val[0]
          return val ? String(val) : undefined
        }

        const portStr = pick('Port')
        const port = portStr ? parseInt(portStr, 10) : undefined

        hostsMap.set(alias, {
          alias,
          hostname: pick('HostName') || alias,
          user: pick('User'),
          port: Number.isFinite(port) ? port : undefined,
          proxyJump: pick('ProxyJump'),
          identityFile: pick('IdentityFile')
        })
      }
    }
  }

  return Array.from(hostsMap.values())
}

export function loadSystemSshConfig(configPath?: string): SshConfigHostSummary[] {
  const target = configPath ?? path.join(os.homedir(), '.ssh', 'config')
  if (!fs.existsSync(target)) return []
  try {
    const content = fs.readFileSync(target, 'utf8')
    return parseSshConfigContent(content, path.dirname(target), new Set([target]))
  } catch {
    return []
  }
}

/**
 * Clean public default config seeded on first run when no local config exists.
 * Users add their own SSH hosts via the UI (`+`), `⌘,`, `~/.config/multiplex-ide/config.json`,
 * or a gitignored `multiplex.local.json`.
 */
export function createDefaultConfig(): MultiplexConfigFile {
  return {
    theme: 'monokai',
    showAllSshConfigHosts: false,
    extraPathDirs: [],
    workspaces: [
      {
        id: 'local',
        name: 'Local',
        kind: 'local',
        defaultPath: '~',
        color: '#66d9ef',
        pinned: true
      }
    ]
  }
}

export class EnvironmentRegistry {
  private configPath: string
  private config: MultiplexConfigFile = createDefaultConfig()
  private environments: Map<string, Environment> = new Map()
  private sshConfigMap: Map<string, SshConfigHostSummary> = new Map()

  constructor(userDataDir: string, explicitConfigPath?: string) {
    this.configPath = this.resolveConfigPath(userDataDir, explicitConfigPath)
    this.loadOrSeedConfig()
    this.refresh()
  }

  /**
   * Config lookup order (all strictly local, never committed to git):
   * 1. Explicit path argument / `MULTIPLEX_CONFIG_PATH` env var
   * 2. Project-local `multiplex.local.json` (gitignored) if present
   * 3. User-level `~/.config/multiplex-ide/config.json`
   * 4. Electron `userData/config.json` fallback
   */
  private resolveConfigPath(userDataDir: string, explicitConfigPath?: string): string {
    if (explicitConfigPath) {
      fs.mkdirSync(path.dirname(explicitConfigPath), { recursive: true })
      return explicitConfigPath
    }

    const envOverride = process.env.MULTIPLEX_CONFIG_PATH
    if (envOverride) {
      const expanded = expandLocalTilde(envOverride)
      fs.mkdirSync(path.dirname(expanded), { recursive: true })
      return expanded
    }

    const localOverride = path.join(process.cwd(), 'multiplex.local.json')
    try {
      if (fs.existsSync(localOverride) && fs.statSync(localOverride).isFile()) {
        return localOverride
      }
    } catch {
      // ignore
    }

    const dotConfigPath = path.join(os.homedir(), '.config', 'multiplex-ide', 'config.json')
    try {
      fs.mkdirSync(path.dirname(dotConfigPath), { recursive: true })
      return dotConfigPath
    } catch {
      const fallback = path.join(userDataDir, 'config.json')
      fs.mkdirSync(path.dirname(fallback), { recursive: true })
      return fallback
    }
  }

  getConfigPath(): string {
    return this.configPath
  }

  getTheme(): EditorThemeId {
    return this.config.theme || 'monokai'
  }

  getExtraPathDirs(): string[] {
    return (this.config.extraPathDirs || []).map(expandLocalTilde)
  }

  getConfig(): MultiplexConfigFile {
    return this.config
  }

  private loadOrSeedConfig(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf8')
        const parsed = JSON.parse(raw) as Partial<MultiplexConfigFile>
        if (Array.isArray(parsed.workspaces) && parsed.workspaces.length > 0) {
          this.config = {
            theme: parsed.theme || 'monokai',
            showAllSshConfigHosts: Boolean(parsed.showAllSshConfigHosts),
            extraPathDirs: Array.isArray(parsed.extraPathDirs) ? parsed.extraPathDirs : [],
            workspaces: parsed.workspaces
          }
          return
        }
      }
    } catch {
      if (fs.existsSync(this.configPath)) {
        return
      }
    }

    this.config = createDefaultConfig()
    this.saveConfig()
  }

  private saveConfig(): void {
    try {
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true })
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2) + '\n', 'utf8')
    } catch {
      // ignore write error
    }
  }

  reloadFromDisk(): { environments: Environment[]; theme: EditorThemeId } {
    this.loadOrSeedConfig()
    return {
      environments: this.refresh(),
      theme: this.getTheme()
    }
  }

  listSshConfigHosts(): SshConfigHostSummary[] {
    return loadSystemSshConfig()
  }

  refresh(): Environment[] {
    const prevStatuses = new Map<string, { status: Environment['status']; statusMessage?: string }>()
    for (const [id, env] of this.environments) {
      prevStatuses.set(id, { status: env.status, statusMessage: env.statusMessage })
    }

    const sshHosts = loadSystemSshConfig()
    this.sshConfigMap = new Map(sshHosts.map((h) => [h.alias, h]))

    const next = new Map<string, Environment>()

    for (const ws of this.config.workspaces) {
      if (ws.kind === 'local') {
        const id = ws.id || 'local'
        const resolvedLocalPath = ws.defaultPath ? expandLocalTilde(ws.defaultPath) : os.homedir()
        next.set(id, {
          id,
          kind: 'local',
          name: ws.name || 'Local',
          defaultPath: resolvedLocalPath,
          color: ws.color || '#66d9ef',
          useTmux: false,
          pinned: ws.pinned ?? true,
          source: 'config',
          status: 'connected'
        })
      } else {
        const hostAlias = ws.host || ws.name
        const id = ws.id || `ssh:${hostAlias}`
        const fromSshCfg = this.sshConfigMap.get(hostAlias)
        const prev = prevStatuses.get(id)
        const delegatesToSshConfig =
          Boolean(fromSshCfg && !ws.hostname) ||
          (!ws.hostname && !ws.user && !ws.port && !ws.proxyJump && !ws.identityFile)

        next.set(id, {
          id,
          kind: 'ssh',
          name: ws.name || hostAlias,
          host: hostAlias,
          hostname: ws.hostname || fromSshCfg?.hostname || hostAlias,
          user: ws.user || fromSshCfg?.user,
          port: ws.port || fromSshCfg?.port,
          proxyJump: ws.proxyJump || fromSshCfg?.proxyJump,
          identityFile: ws.identityFile || fromSshCfg?.identityFile,
          defaultPath: ws.defaultPath || '~',
          color: ws.color || pickColorForHost(ws.name || hostAlias),
          useTmux: ws.useTmux ?? true,
          tmuxSessionName: ws.tmuxSessionName || 'multiplex',
          pinned: ws.pinned ?? false,
          source: delegatesToSshConfig ? 'ssh-config' : 'config',
          status: prev?.status ?? 'disconnected',
          statusMessage: prev?.statusMessage
        })
      }
    }

    if (this.config.showAllSshConfigHosts) {
      for (const h of sshHosts) {
        const id = `ssh:${h.alias}`
        if (next.has(id)) continue
        const prev = prevStatuses.get(id)
        next.set(id, {
          id,
          kind: 'ssh',
          name: h.alias,
          host: h.alias,
          hostname: h.hostname,
          user: h.user,
          port: h.port,
          proxyJump: h.proxyJump,
          identityFile: h.identityFile,
          defaultPath: '~',
          color: pickColorForHost(h.alias),
          useTmux: true,
          tmuxSessionName: 'multiplex',
          pinned: false,
          source: 'ssh-config',
          status: prev?.status ?? 'disconnected',
          statusMessage: prev?.statusMessage
        })
      }
    }

    this.environments = next
    return this.list()
  }

  list(): Environment[] {
    return Array.from(this.environments.values())
  }

  get(envId: string): Environment | undefined {
    return this.environments.get(envId)
  }

  addOrUpdateCustom(input: CustomHostInput): Environment {
    const host = input.host
    const id = input.id || `ssh:${host || input.name}`
    const entry: WorkspaceConfigEntry = {
      id,
      name: input.name,
      kind: 'ssh',
      host,
      hostname: input.hostname && input.hostname !== host ? input.hostname : undefined,
      user: input.user || undefined,
      port: input.port && input.port !== 22 ? input.port : undefined,
      proxyJump: input.proxyJump || undefined,
      identityFile: input.identityFile || undefined,
      defaultPath: input.defaultPath || '~',
      color: input.color || pickColorForHost(input.name),
      useTmux: input.useTmux ?? true,
      tmuxSessionName: input.tmuxSessionName
    }

    const idx = this.config.workspaces.findIndex((w) => (w.id || `ssh:${w.host || w.name}`) === id)
    if (idx >= 0) {
      this.config.workspaces[idx] = entry
    } else {
      this.config.workspaces.push(entry)
    }
    this.saveConfig()
    this.refresh()
    return this.environments.get(id)!
  }

  deleteCustom(envId: string): void {
    this.config.workspaces = this.config.workspaces.filter((w) => {
      const wid = w.id || (w.kind === 'local' ? 'local' : `ssh:${w.host || w.name}`)
      return wid !== envId
    })
    if (this.config.workspaces.length === 0) {
      this.config.workspaces = [createDefaultConfig().workspaces[0]]
    }
    this.saveConfig()
    this.refresh()
  }

  updateSettings(
    envId: string,
    patch: Partial<Pick<Environment, 'defaultPath' | 'useTmux' | 'tmuxSessionName' | 'pinned' | 'color'>> & {
      theme?: EditorThemeId
    }
  ): Environment | undefined {
    if (patch.theme) {
      this.config.theme = patch.theme
      this.saveConfig()
    }
    const existing = this.environments.get(envId)
    if (!existing) return undefined

    const ws = this.config.workspaces.find((w) => {
      const wid = w.id || (w.kind === 'local' ? 'local' : `ssh:${w.host || w.name}`)
      return wid === envId
    })
    if (ws) {
      if (patch.defaultPath !== undefined) ws.defaultPath = patch.defaultPath
      if (patch.useTmux !== undefined) ws.useTmux = patch.useTmux
      if (patch.tmuxSessionName !== undefined) ws.tmuxSessionName = patch.tmuxSessionName
      if (patch.pinned !== undefined) ws.pinned = patch.pinned
      if (patch.color !== undefined) ws.color = patch.color
      this.saveConfig()
    }
    Object.assign(existing, patch)
    return existing
  }

  setStatus(envId: string, status: Environment['status'], statusMessage?: string): Environment | undefined {
    const env = this.environments.get(envId)
    if (!env) return undefined
    env.status = status
    env.statusMessage = statusMessage
    return env
  }
}
