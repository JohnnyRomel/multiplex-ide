import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  parseSshConfigContent,
  EnvironmentRegistry,
  createDefaultConfig
} from '../src/main/ssh/configParser'
import { SshControlMaster } from '../src/main/ssh/controlMaster'
import {
  buildRemoteTmuxBootstrapCommand,
  extractMideTmuxMarker,
  parseOscNotifications,
  parseRecoverableTmuxOutput,
  stripEraseScrollback
} from '../src/main/terminal/terminalManager'
import { UnifiedVfs } from '../src/main/fs/vfs'
import { TransferManager } from '../src/main/fs/transferManager'
import { SearchManager, parseGrepLine, parseRgJsonLine, scoreQuickOpenCandidate } from '../src/main/search/searchManager'
import { enhancedCppLanguage, enhancedPythonLanguage } from '../src/shared/syntaxGrammars'
import { decodeOsc52Payload } from '../src/shared/osc52'
import { TerminalFrameBuffer } from '../src/shared/terminalFrameBuffer'
// @ts-expect-error internal monaco esm module for unit testing Monarch compilation
import { compile } from 'monaco-editor/esm/vs/editor/standalone/common/monarch/monarchCompile.js'
import type { Environment, SearchDoneEvent, SearchMatch, TransferTask } from '../src/shared/types'

let tmpRoot: string

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multiplex-ide-test-'))
})

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('Config File & SSH Config Parser', () => {
  it('seeds a clean public default config containing only the Local workspace', () => {
    const def = createDefaultConfig()
    expect(def.theme).toBe('monokai')
    expect(def.showAllSshConfigHosts).toBe(false)
    expect(def.workspaces).toHaveLength(1)
    expect(def.workspaces[0]).toMatchObject({ id: 'local', name: 'Local', kind: 'local', defaultPath: '~' })
  })

  it('persists and hot-reloads local config.json edits cleanly', () => {
    const userData = path.join(tmpRoot, 'userdata')
    const cfgPath = path.join(tmpRoot, 'config.json')
    const reg = new EnvironmentRegistry(userData, cfgPath)

    expect(fs.existsSync(cfgPath)).toBe(true)
    expect(reg.list().map((e) => e.name)).toEqual(['Local'])

    // Add a custom SSH host and edit config.json on disk to verify hot-reload
    const added = reg.addOrUpdateCustom({
      name: 'dev-server',
      host: 'dev-server',
      defaultPath: '~/workspace',
      useTmux: true
    })
    expect(added.defaultPath).toBe('~/workspace')

    const edited = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    edited.theme = 'mariana'
    edited.workspaces[1].defaultPath = '/data/workspace'
    fs.writeFileSync(cfgPath, JSON.stringify(edited, null, 2))

    const reloaded = reg.reloadFromDisk()
    expect(reloaded.theme).toBe('mariana')
    expect(reloaded.environments.find((e) => e.name === 'dev-server')?.defaultPath).toBe('/data/workspace')
  })

  it('parses hosts, ProxyJump, Port, wildcards, and Include files from ssh_config', () => {
    const incDir = path.join(tmpRoot, 'ssh_inc')
    fs.mkdirSync(incDir, { recursive: true })
    fs.writeFileSync(
      path.join(incDir, 'extra.conf'),
      `
Host dev-server
  HostName 10.20.30.40
  User devuser
  Port 2222
  ProxyJump bastion
`
    )

    const mainConfig = `
Include ${incDir}/*.conf

Host *
  ServerAliveInterval 60

Host gpu-box staging-box
  HostName 192.168.1.10
  User ubuntu
`

    const hosts = parseSshConfigContent(mainConfig, tmpRoot)
    const names = hosts.map((h) => h.alias)
    expect(names).toContain('dev-server')
    expect(names).toContain('gpu-box')
    expect(names).not.toContain('*')

    const dev = hosts.find((h) => h.alias === 'dev-server')!
    expect(dev.hostname).toBe('10.20.30.40')
    expect(dev.user).toBe('devuser')
    expect(dev.port).toBe(2222)
    expect(dev.proxyJump).toBe('bastion')
  })
})

describe('OSC Terminal Notification & Scrollback Protection', () => {
  it('extracts OSC 9, OSC 777, and OSC 99 notifications while ignoring ConEmu progress', () => {
    const stream =
      'normal output \x1b]9;Build finished!\x07 middle ' +
      '\x1b]9;4;1;50\x07 ' +
      '\x1b]777;notify;Agent;Needs approval\x1b\\ ' +
      '\x1b]99;i=1:d=0;Tests passed\x07'

    const notes = parseOscNotifications(stream)
    expect(notes).toHaveLength(3)
    expect(notes[0].body).toBe('Build finished!')
    expect(notes[1]).toEqual({ title: 'Agent', body: 'Needs approval' })
    expect(notes[2].body).toBe('Tests passed')
  })

  it('strips ESC[3J erase-scrollback sequence while keeping normal ANSI output intact', () => {
    const input = 'before\x1b[3J\x1b[2J\x1b[32mafter\x1b[0m'
    expect(stripEraseScrollback(input)).toBe('before\x1b[2J\x1b[32mafter\x1b[0m')
  })
})

describe('Search Parsers & End-to-End Local Search / Goto Files', () => {
  it('parses rg --json output lines accurately', () => {
    const jsonLine = JSON.stringify({
      type: 'match',
      data: {
        path: { text: '/repo/src/app.ts' },
        lines: { text: 'const multiplex = true\n' },
        line_number: 12,
        submatches: [{ start: 6, end: 15 }]
      }
    })
    const matches = parseRgJsonLine(jsonLine, 's1', 'local', '/repo')
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      envId: 'local',
      filePath: '/repo/src/app.ts',
      relativePath: 'src/app.ts',
      line: 12,
      column: 7,
      matchLength: 9
    })
  })

  it('computes accurate match column in grep fallback parser', () => {
    const m = parseGrepLine('/repo/a.txt:42:prefix WORLD suffix', 's2', 'ssh:dev-server', '/repo', 'world', {
      isCaseSensitive: false
    })
    expect(m).toMatchObject({
      envId: 'ssh:dev-server',
      relativePath: 'a.txt',
      line: 42,
      column: 8,
      matchLength: 5,
      lineText: 'prefix WORLD suffix'
    })
  })

  it('executes fast local ripgrep search and bounded quick-open file listing excluding ignored dirs', async () => {
    const searchDir = path.join(tmpRoot, 'search_ws')
    fs.mkdirSync(path.join(searchDir, 'sub'), { recursive: true })
    fs.mkdirSync(path.join(searchDir, 'node_modules', 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(searchDir, 'alpha.ts'), 'export const MAGIC_TOKEN = 42\n')
    fs.writeFileSync(path.join(searchDir, 'sub', 'beta.py'), 'print("MAGIC_TOKEN found")\n')
    fs.writeFileSync(path.join(searchDir, 'node_modules', 'pkg', 'ignored.js'), 'MAGIC_TOKEN\n')

    const ctl = new SshControlMaster(path.join(tmpRoot, 'ctl'))
    const collected: SearchMatch[] = []
    let doneEvt: SearchDoneEvent | undefined

    const sm = new SearchManager(ctl, {
      onMatchBatch: (b) => collected.push(...b),
      onDone: (d) => {
        doneEvt = d
      }
    })

    const localEnv: Environment = {
      id: 'local',
      kind: 'local',
      name: 'Local',
      defaultPath: searchDir,
      color: '#66d9ef',
      useTmux: false,
      source: 'config',
      status: 'connected'
    }

    await sm.startSearch(
      {
        searchId: 'test-search',
        query: 'MAGIC_TOKEN',
        targets: [{ envId: 'local', rootPath: searchDir }]
      },
      () => localEnv
    )

    expect(collected.length).toBe(2)
    expect((doneEvt as SearchDoneEvent | undefined)?.totalMatches).toBe(2)

    const files = await sm.listFiles(localEnv, searchDir)
    expect(files.map((f) => f.name).sort()).toEqual(['alpha.ts', 'beta.py'])
  })

  it('finds deep & symlinked C++ files like my_service_feature_handler.cpp when querying feature_handler.cpp', async () => {
    const realRepo = path.join(tmpRoot, 'real_storage_repo')
    const deepDir = path.join(realRepo, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'service')
    fs.mkdirSync(deepDir, { recursive: true })
    fs.writeFileSync(path.join(deepDir, 'my_service_feature_handler.cpp'), 'void HandleFeature() {}\n')
    fs.writeFileSync(path.join(deepDir, 'my_service_feature_handler.h'), '#pragma once\n')
    fs.writeFileSync(path.join(realRepo, 'feature_store_helper.cpp'), 'int x = 1;\n')

    const symlinkWorkspace = path.join(tmpRoot, 'symlinked_workspace')
    fs.symlinkSync(realRepo, symlinkWorkspace)

    const ctl = new SshControlMaster(path.join(tmpRoot, 'ctl_sym'))
    const sm = new SearchManager(ctl, {
      onMatchBatch: () => {},
      onDone: () => {}
    })

    const localEnv: Environment = {
      id: 'local',
      kind: 'local',
      name: 'Local',
      defaultPath: symlinkWorkspace,
      color: '#66d9ef',
      useTmux: false,
      source: 'config',
      status: 'connected'
    }

    const hits = await sm.searchFiles(localEnv, symlinkWorkspace, 'feature_handler.cpp')
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0].name).toBe('my_service_feature_handler.cpp')

    const headerHits = await sm.searchFiles(localEnv, symlinkWorkspace, 'service handler .h')
    expect(headerHits.some((f) => f.name === 'my_service_feature_handler.h')).toBe(true)

    const s1 = scoreQuickOpenCandidate(
      {
        envId: 'ssh:dev-server',
        filePath: '/w/my_service_feature_handler.cpp',
        relativePath: 'a/b/my_service_feature_handler.cpp',
        name: 'my_service_feature_handler.cpp'
      },
      'feature_handler.cpp'
    )
    const s2 = scoreQuickOpenCandidate(
      {
        envId: 'ssh:dev-server',
        filePath: '/w/feature/my_handler.cpp',
        relativePath: 'feature/my_handler.cpp',
        name: 'my_handler.cpp'
      },
      'feature_handler.cpp'
    )
    expect(s1).toBeGreaterThan(s2)
  })
})

describe('Unified VFS & TransferManager', () => {
  it('recursively transfers folders and streams files with progress updates', async () => {
    const srcDir = path.join(tmpRoot, 'xfer_src')
    const dstDir = path.join(tmpRoot, 'xfer_dst')
    fs.mkdirSync(path.join(srcDir, 'nested'), { recursive: true })
    fs.mkdirSync(dstDir, { recursive: true })
    fs.writeFileSync(path.join(srcDir, 'hello.txt'), 'hello multiplex')
    fs.writeFileSync(path.join(srcDir, 'nested', 'data.bin'), Buffer.from([0, 1, 2, 3, 255]))

    const ctl = new SshControlMaster(path.join(tmpRoot, 'ctl2'))
    const vfs = new UnifiedVfs(ctl)
    const updates: TransferTask[] = []

    const tm = new TransferManager(vfs, (t) => updates.push(t))
    const localEnv: Environment = {
      id: 'local',
      kind: 'local',
      name: 'Local',
      defaultPath: tmpRoot,
      color: '#66d9ef',
      useTmux: false,
      source: 'config',
      status: 'connected'
    }

    const binRead = await vfs.readFile(localEnv, path.join(srcDir, 'nested', 'data.bin'))
    expect(binRead.isBinary).toBe(true)

    const txtRead = await vfs.readFile(localEnv, path.join(srcDir, 'hello.txt'))
    expect(txtRead.isBinary).toBe(false)
    expect(txtRead.content).toBe('hello multiplex')

    const task = await tm.enqueue(localEnv, localEnv, {
      sourceEnvId: 'local',
      sourcePath: srcDir,
      targetEnvId: 'local',
      targetDir: dstDir
    })

    await new Promise<void>((resolve, reject) => {
      const start = Date.now()
      const timer = setInterval(() => {
        const latest = tm.list().find((t) => t.id === task.id)
        if (latest?.status === 'completed') {
          clearInterval(timer)
          resolve()
        } else if (latest?.status === 'failed') {
          clearInterval(timer)
          reject(new Error(latest.error))
        } else if (Date.now() - start > 5000) {
          clearInterval(timer)
          reject(new Error('Transfer timeout'))
        }
      }, 30)
    })

    expect(fs.readFileSync(path.join(dstDir, 'xfer_src', 'hello.txt'), 'utf8')).toBe('hello multiplex')
    expect(fs.existsSync(path.join(dstDir, 'xfer_src', 'nested', 'data.bin'))).toBe(true)
    expect(updates.some((u) => u.status === 'completed')).toBe(true)
  })
})

describe('Enhanced Non-LSP C++ and Python Monarch Grammars', () => {
  it('compiles enhanced C++ and Python Monarch grammars without any invalid rule errors', () => {
    const compiledCpp = compile('cpp', enhancedCppLanguage)
    expect(compiledCpp.tokenPostfix).toBe('.cpp')
    expect(compiledCpp.tokenizer.root.length).toBeGreaterThan(10)

    const compiledPy = compile('python', enhancedPythonLanguage)
    expect(compiledPy.tokenPostfix).toBe('.python')
    expect(compiledPy.tokenizer.root.length).toBeGreaterThan(10)
  })
})

describe('OSC 52 Remote Clipboard Decoding', () => {
  it('decodes ASCII and UTF-8 Chinese OSC 52 payloads and ignores queries/invalid inputs', () => {
    const asciiB64 = Buffer.from('hello multiplex', 'utf8').toString('base64')
    expect(decodeOsc52Payload(`c;${asciiB64}`)).toBe('hello multiplex')

    const utf8B64 = Buffer.from('你好 MultiplexIDE 剪贴板！', 'utf8').toString('base64')
    expect(decodeOsc52Payload(`c;${utf8B64}`)).toBe('你好 MultiplexIDE 剪贴板！')

    expect(decodeOsc52Payload('c;?')).toBeNull()
    expect(decodeOsc52Payload('invalid-no-semicolon')).toBeNull()
    expect(decodeOsc52Payload('c;!!!not-base64!!!')).toBeNull()
  })
})

describe('SSH ControlMaster Resilience & Multi-Tab Reconnect Deduplication', () => {
  it('enforces bounded ConnectTimeout and fast keepalives on interactive SSH terminals and deduplicates socket resets', async () => {
    const ctlDir = path.join(tmpRoot, 'ctl-test')
    const cm = new SshControlMaster(ctlDir)
    const sshEnv: Environment = {
      id: 'ssh:test-box',
      kind: 'ssh',
      name: 'test-box',
      host: 'test-box',
      hostname: '127.0.0.1',
      port: 2222,
      defaultPath: '~',
      color: '#a6e22e',
      useTmux: true,
      source: 'config',
      status: 'disconnected'
    }

    const interactiveArgs = cm.buildBaseSshArgs(sshEnv, { interactive: true })
    expect(interactiveArgs).toContain('ServerAliveInterval=10')
    expect(interactiveArgs).toContain('ServerAliveCountMax=2')
    expect(interactiveArgs).toContain('ConnectTimeout=12')

    const ctlPath = cm.getControlPath(sshEnv)
    fs.writeFileSync(ctlPath, 'stale-socket-placeholder')
    expect(fs.existsSync(ctlPath)).toBe(true)

    // First reset cleans up the stale file
    await cm.resetControlSocket(sshEnv)
    expect(fs.existsSync(ctlPath)).toBe(false)

    // Recreate a file simulating a newly established ControlMaster right after reset;
    // a non-forced reset from a sibling tab within the 3.5s cooldown must NOT delete it!
    fs.writeFileSync(ctlPath, 'fresh-master-placeholder')
    await cm.resetControlSocket(sshEnv)
    expect(fs.existsSync(ctlPath)).toBe(true)

    // Explicit disconnect (force: true) removes it immediately
    await cm.disconnect(sshEnv)
    expect(fs.existsSync(ctlPath)).toBe(false)
  })

  it('enables tmux -u attach-session -d, 256color, idempotent OSC 52, and mouse wheel bindings', () => {
    const cmd = buildRemoteTmuxBootstrapCommand('mide_1_abcd', '/workspace/demo')
    expect(cmd).toContain('tmux set-option -g mouse on')
    expect(cmd).toContain('tmux set-option -t "$MIDE_S" mouse on')
    expect(cmd).toContain('tmux set-option -t "$MIDE_S" status off')
    expect(cmd).toContain('tmux set-option -t "$MIDE_S" history-limit 50000')
    expect(cmd).toContain('tmux set-option -s default-terminal "$MIDE_TERM"')
    expect(cmd).toContain('aggressive-resize on')
    expect(cmd).toContain('grep -q \'Ms=\'')
    expect(cmd).toContain('set-clipboard on')
    expect(cmd).toContain("select-pane '\\;' send-keys -X -N 3 scroll-up")
    expect(cmd).toContain('exec tmux -u attach-session -d -t "$MIDE_S"')

    // If tmux is installed locally, execute the exact setup snippet against an isolated server
    // to prove shell quoting, idempotent terminal-overrides, and active-command priority end-to-end!
    let hasTmux = false
    try {
      execFileSync('/bin/sh', ['-c', 'command -v tmux >/dev/null 2>&1'])
      hasTmux = true
    } catch {
      hasTmux = false
    }
    if (hasTmux) {
      const sock = `mide_ut_${process.pid}_${Date.now().toString(36)}`
      const runTmuxBootstrap = (raw: string) => {
        const setupOnly = raw
          .replace(/exec tmux -u attach-session -d -t "\$MIDE_S";/, '')
          .replace(/\btmux /g, `tmux -L ${sock} -f /dev/null `)
        return execFileSync('/bin/sh', ['-c', setupOnly], { encoding: 'utf8' })
      }
      try {
        const out = runTmuxBootstrap(cmd)
        const marker = extractMideTmuxMarker(out)
        expect(marker.sessionName).toBe('mide_1_abcd')
        expect(marker.cleaned).toBe('')

        // Running bootstrap a second time must NOT append duplicate terminal-overrides entries!
        runTmuxBootstrap(cmd)
        const overrides = execFileSync('tmux', ['-L', sock, 'show-options', '-s', 'terminal-overrides'], {
          encoding: 'utf8'
        })
        const msLines = overrides.split('\n').filter((l) => l.includes('Ms='))
        expect(msLines.length).toBeLessThanOrEqual(2)

        const mouseOpt = execFileSync('tmux', ['-L', sock, 'show-options', '-t', 'mide_1_abcd', 'mouse'], {
          encoding: 'utf8'
        }).trim()
        expect(mouseOpt).toBe('mouse on')

        const copyKeys = execFileSync('tmux', ['-L', sock, 'list-keys', '-T', 'copy-mode'], {
          encoding: 'utf8'
        })
        const upLine = copyKeys.split('\n').find((l) => l.includes('WheelUpPane')) || ''
        const downLine = copyKeys.split('\n').find((l) => l.includes('WheelDownPane')) || ''
        expect(upLine).toContain('select-pane')
        expect(upLine).toContain('scroll-up')
        expect(downLine).toContain('select-pane')
        expect(downLine).toContain('scroll-down')

        const viKeys = execFileSync('tmux', ['-L', sock, 'list-keys', '-T', 'copy-mode-vi'], {
          encoding: 'utf8'
        })
        const viUpLine = viKeys.split('\n').find((l) => l.includes('WheelUpPane')) || ''
        expect(viUpLine).toContain('select-pane')
        expect(viUpLine).toContain('scroll-up')

        // Now test `attachRecent: true` automatically discovers and reattaches `mide_1_abcd`!
        const reattachOut = runTmuxBootstrap(
          buildRemoteTmuxBootstrapCommand('mide_9_new', '/workspace/demo', {
            attachRecent: true,
            maxAgeSec: 3600
          })
        )
        expect(extractMideTmuxMarker(reattachOut).sessionName).toBe('mide_1_abcd')
      } finally {
        try {
          execFileSync('tmux', ['-L', sock, 'kill-server'], { stdio: 'ignore' })
        } catch {
          // ignore
        }
      }
    }
  })

  it('prioritizes active non-shell commands (e.g. agy) over newer idle shells and parses OSC 9991 markers', () => {
    const now = 1795600000
    const sample = [
      `__NOW__:${now}`,
      `mide_old\t${now - 7200}\t0\tagy\t/workspace\t1\t190x44`,
      `mide_attached\t${now - 100}\t1\tagy\t/workspace\t1\t190x44`,
      `personal_dev\t${now - 60}\t0\tzsh\t/home/user\t1\t190x44`,
      `mide_idle_newer\t${now - 90}\t0\tzsh\t/workspace\t1\t190x44`,
      `mide_agy_older\t${now - 300}\t0\tagy\t/workspace/app\t1\t262x53`,
      `mide_owned\t${now - 50}\t0\tbash\t/workspace\t1\t190x44`
    ].join('\n')

    const list = parseRecoverableTmuxOutput(sample, 3600, new Set(['mide_owned']))
    // Active `agy` session MUST outrank slightly newer empty `zsh` shell!
    expect(list.map((s) => s.name)).toEqual(['mide_agy_older', 'mide_idle_newer'])
    expect(list[0].command).toBe('agy')
    expect(list[0].ageSec).toBe(300)
    expect(list[0].size).toBe('262x53')
    expect(list[1].ageSec).toBe(90)

    // With includeGhostAttached: true, ghost-attached unowned sessions are still recoverable behind unattached ones
    const withGhost = parseRecoverableTmuxOutput(sample, 3600, new Set(['mide_owned']), {
      includeGhostAttached: true
    })
    expect(withGhost.map((s) => s.name)).toEqual(['mide_agy_older', 'mide_idle_newer', 'mide_attached'])

    const extracted = extractMideTmuxMarker('before\x1b]9991;mide_agy_older\x07after')
    expect(extracted.sessionName).toBe('mide_agy_older')
    expect(extracted.cleaned).toBe('beforeafter')
  })
})

describe('Anti-Flicker Terminal Frame Coalescer', () => {
  it('holds DEC 2026 synchronized frames across split SSH chunks and flushes atomically on ESU', () => {
    const flushed: string[] = []
    let frameCb: (() => void) | null = null
    let timeoutCb: (() => void) | null = null
    const buf = new TerminalFrameBuffer((b) => flushed.push(b), {
      scheduleFrame: (cb) => {
        frameCb = cb
        return () => {
          if (frameCb === cb) frameCb = null
        }
      },
      scheduleTimeout: (cb) => {
        timeoutCb = cb
        return () => {
          if (timeoutCb === cb) timeoutCb = null
        }
      }
    })

    // Split `\x1b[?2026h` across two TCP chunks + erase + redraw + `\x1b[?2026l`
    buf.push('\x1b[?20')
    buf.push('26h\x1b[2J\x1b[H')
    expect(flushed).toEqual([])
    expect(frameCb).toBeNull() // Held until ESU arrives!
    expect(timeoutCb).not.toBeNull() // Safety watchdog armed

    buf.push('rendered TUI line\x1b[?2026l')
    expect(flushed).toEqual([])
    expect(frameCb).not.toBeNull() // Ready for next VSync paint!
    frameCb!()
    expect(flushed).toEqual(['\x1b[2J\x1b[Hrendered TUI line'])
    buf.dispose()
  })

  it('coalesces tmux 2.8 cursor-hide redraw cycles (`?25l` ... `?25h`) into a single write', () => {
    const flushed: string[] = []
    let frameCb: (() => void) | null = null
    let timeoutCb: (() => void) | null = null
    const buf = new TerminalFrameBuffer((b) => flushed.push(b), {
      scheduleFrame: (cb) => {
        frameCb = cb
        return () => {
          if (frameCb === cb) frameCb = null
        }
      },
      scheduleTimeout: (cb) => {
        timeoutCb = cb
        return () => {
          if (timeoutCb === cb) timeoutCb = null
        }
      }
    })

    // Chunk 1: hide cursor + erase lines (typical tmux 2.8 / Ink TUI mid-frame)
    buf.push('\x1b[?25l\x1b[2K\r')
    expect(flushed).toEqual([])
    expect(frameCb).toBeNull() // Briefly held for redraw completion
    expect(timeoutCb).not.toBeNull()

    // Chunk 2: new text + restore cursor
    buf.push('agy prompt > \x1b[?25h')
    expect(frameCb).not.toBeNull()
    frameCb!()
    expect(flushed).toEqual(['\x1b[?25l\x1b[2K\ragy prompt > \x1b[?25h'])
    buf.dispose()
  })

  it('does NOT stall interactive typing or plain cursor-hide chunks lacking an erase sequence', () => {
    const flushed: string[] = []
    let frameCb: (() => void) | null = null
    let timeoutCb: (() => void) | null = null
    const buf = new TerminalFrameBuffer((b) => flushed.push(b), {
      scheduleFrame: (cb) => {
        frameCb = cb
        return () => {
          if (frameCb === cb) frameCb = null
        }
      },
      scheduleTimeout: (cb) => {
        timeoutCb = cb
        return () => {
          if (timeoutCb === cb) timeoutCb = null
        }
      }
    })

    // Plain typing echo or TUI cursor hide WITHOUT clear-line/clear-screen must flush on next VSync immediately
    buf.push('\x1b[?25lhello')
    expect(timeoutCb).toBeNull()
    expect(frameCb).not.toBeNull()
    frameCb!()
    expect(flushed).toEqual(['\x1b[?25lhello'])
    buf.dispose()
  })
})
