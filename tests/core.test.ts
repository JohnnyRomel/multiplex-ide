import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseSshConfigContent, EnvironmentRegistry, createDefaultConfig } from '../src/main/ssh/configParser'
import { SshControlMaster } from '../src/main/ssh/controlMaster'
import { parseOscNotifications } from '../src/main/terminal/terminalManager'
import { UnifiedVfs } from '../src/main/fs/vfs'
import { TransferManager } from '../src/main/fs/transferManager'
import { SearchManager, parseGrepLine, parseRgJsonLine, scoreQuickOpenCandidate } from '../src/main/search/searchManager'
import { enhancedCppLanguage, enhancedPythonLanguage } from '../src/shared/syntaxGrammars'
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
  it('seeds default config with only Local Mac, dev92 (~/workspace), and cn_a10 (~)', () => {
    const def = createDefaultConfig()
    expect(def.theme).toBe('monokai')
    expect(def.showAllSshConfigHosts).toBe(false)
    expect(def.workspaces.map((w) => w.name)).toEqual(['Local Mac', 'dev92', 'cn_a10'])
    expect(def.workspaces[1]).toMatchObject({ host: 'dev92', defaultPath: '~/workspace' })
    expect(def.workspaces[2]).toMatchObject({ host: 'cn_a10', defaultPath: '~' })
  })

  it('persists and hot-reloads config.json edits cleanly', () => {
    const userData = path.join(tmpRoot, 'userdata')
    const cfgPath = path.join(tmpRoot, 'config.json')
    const reg = new EnvironmentRegistry(userData, cfgPath)

    expect(fs.existsSync(cfgPath)).toBe(true)
    expect(reg.list().map((e) => e.name)).toEqual(['Local Mac', 'dev92', 'cn_a10'])

    // Edit config.json on disk and verify hot-reload
    const edited = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    edited.theme = 'mariana'
    edited.workspaces[1].defaultPath = '/data/workspace'
    fs.writeFileSync(cfgPath, JSON.stringify(edited, null, 2))

    const reloaded = reg.reloadFromDisk()
    expect(reloaded.theme).toBe('mariana')
    expect(reloaded.environments.find((e) => e.name === 'dev92')?.defaultPath).toBe('/data/workspace')
  })

  it('parses hosts, ProxyJump, Port, wildcards, and Include files from ssh_config', () => {
    const incDir = path.join(tmpRoot, 'ssh_inc')
    fs.mkdirSync(incDir, { recursive: true })
    fs.writeFileSync(
      path.join(incDir, 'extra.conf'),
      `
Host dev92
  HostName 10.20.30.92
  User devuser
  Port 2222
  ProxyJump bastion
`
    )

    const mainConfig = `
Include ${incDir}/*.conf

Host *
  ServerAliveInterval 60

Host cn_a10 extra-unused
  HostName 192.168.1.10
  User root
`

    const hosts = parseSshConfigContent(mainConfig, tmpRoot)
    const names = hosts.map((h) => h.alias)
    expect(names).toContain('dev92')
    expect(names).toContain('cn_a10')
    expect(names).not.toContain('*')

    const dev92 = hosts.find((h) => h.alias === 'dev92')!
    expect(dev92.hostname).toBe('10.20.30.92')
    expect(dev92.user).toBe('devuser')
    expect(dev92.port).toBe(2222)
    expect(dev92.proxyJump).toBe('bastion')
  })
})

describe('OSC Terminal Notification Parser', () => {
  it('extracts OSC 9, OSC 777, and OSC 99 notifications while ignoring ConEmu progress', () => {
    const stream =
      'normal output \x1b]9;Build finished!\x07 middle ' +
      '\x1b]9;4;1;50\x07 ' +
      '\x1b]777;notify;Claude Code;Needs approval\x1b\\ ' +
      '\x1b]99;i=1:d=0;Tests passed\x07'

    const notes = parseOscNotifications(stream)
    expect(notes).toHaveLength(3)
    expect(notes[0].body).toBe('Build finished!')
    expect(notes[1]).toEqual({ title: 'Claude Code', body: 'Needs approval' })
    expect(notes[2].body).toBe('Tests passed')
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
    const m = parseGrepLine('/repo/a.txt:42:prefix WORLD suffix', 's2', 'ssh:dev92', '/repo', 'world', {
      isCaseSensitive: false
    })
    expect(m).toMatchObject({
      envId: 'ssh:dev92',
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
      name: 'Local Mac',
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

  it('finds deep & symlinked C++ files like tiktok_monarch_feature_handler.cpp when querying feature_handler.cpp', async () => {
    const realRepo = path.join(tmpRoot, 'real_data00_repo')
    const deepDir = path.join(realRepo, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'monarch')
    fs.mkdirSync(deepDir, { recursive: true })
    fs.writeFileSync(path.join(deepDir, 'tiktok_monarch_feature_handler.cpp'), 'void HandleFeature() {}\n')
    fs.writeFileSync(path.join(deepDir, 'tiktok_monarch_feature_handler.h'), '#pragma once\n')
    fs.writeFileSync(path.join(realRepo, 'feature_store_helper.cpp'), 'int x = 1;\n')

    // Simulate dev92 style symlinked ~/workspace -> /data00/...
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
      name: 'Local Mac',
      defaultPath: symlinkWorkspace,
      color: '#66d9ef',
      useTmux: false,
      source: 'config',
      status: 'connected'
    }

    const hits = await sm.searchFiles(localEnv, symlinkWorkspace, 'feature_handler.cpp')
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0].name).toBe('tiktok_monarch_feature_handler.cpp')

    // Multi-token query ("monarch handler h")
    const headerHits = await sm.searchFiles(localEnv, symlinkWorkspace, 'monarch handler .h')
    expect(headerHits.some((f) => f.name === 'tiktok_monarch_feature_handler.h')).toBe(true)

    // Verify ranking prioritizes suffix match over scattered path match
    const s1 = scoreQuickOpenCandidate(
      {
        envId: 'ssh:dev92',
        filePath: '/w/tiktok_monarch_feature_handler.cpp',
        relativePath: 'a/b/tiktok_monarch_feature_handler.cpp',
        name: 'tiktok_monarch_feature_handler.cpp'
      },
      'feature_handler.cpp'
    )
    const s2 = scoreQuickOpenCandidate(
      {
        envId: 'ssh:dev92',
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
      name: 'Local Mac',
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
