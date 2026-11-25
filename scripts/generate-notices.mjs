#!/usr/bin/env node
/**
 * Audits all runtime dependencies (direct + transitive + Electron) for MIT compatibility
 * and generates THIRD_PARTY_NOTICES.md containing verbatim upstream license & copyright notices.
 *
 * Usage:
 *   node scripts/generate-notices.mjs          # Generates THIRD_PARTY_NOTICES.md
 *   node scripts/generate-notices.mjs --check  # Fails if incompatible licenses exist or file is stale
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'))

const ALLOWED_LICENSES = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'Unlicense',
  'CC0-1.0',
  '0BSD',
  '(MIT OR CC0-1.0)'
])

function resolvePkgDir(name, fromDir) {
  let cur = fromDir
  while (true) {
    const candidate = path.join(cur, 'node_modules', name, 'package.json')
    if (fs.existsSync(candidate)) return path.dirname(candidate)
    const parent = path.dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

function normalizeLicense(pkg) {
  if (typeof pkg.license === 'string') return pkg.license.trim()
  if (pkg.license && typeof pkg.license === 'object' && pkg.license.type) return String(pkg.license.type).trim()
  if (Array.isArray(pkg.licenses) && pkg.licenses.length > 0) {
    return pkg.licenses.map((l) => (typeof l === 'string' ? l : l.type)).filter(Boolean).join(' OR ')
  }
  return 'UNKNOWN'
}

function readLicenseText(pkgDir) {
  const entries = fs.readdirSync(pkgDir)
  const candidates = entries
    .filter((f) => /^(licen[sc]e|copying|notice)(\.(md|txt))?$/i.test(f))
    .sort((a, b) => a.length - b.length)

  const parts = []
  for (const file of candidates) {
    const full = path.join(pkgDir, file)
    try {
      if (fs.statSync(full).isFile()) {
        const text = fs.readFileSync(full, 'utf8').trim()
        if (text) parts.push(text)
      }
    } catch {
      // ignore
    }
  }
  return parts.join('\n\n---\n\n')
}

function normalizeRepoUrl(repo) {
  if (!repo) return ''
  let raw = typeof repo === 'string' ? repo : repo.url || ''
  raw = raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^http:\/\/github\.com\//, 'https://github.com/')
    .replace(/^github:/, 'https://github.com/')
    .replace(/\.git$/, '')
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(raw)) {
    raw = `https://github.com/${raw}`
  }
  return raw
}

// Walk direct runtime dependencies (and electron, excluding electron's own npm installer-only deps)
const visited = new Map()
const queue = Object.keys(rootPkg.dependencies || {}).map((n) => ({ name: n, from: rootDir, direct: true }))

while (queue.length > 0) {
  const { name, from, direct } = queue.shift()
  const dir = resolvePkgDir(name, from)
  if (!dir) continue
  const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const key = `${p.name}@${p.version}`
  if (visited.has(key)) {
    if (direct) visited.get(key).direct = true
    continue
  }

  const license = normalizeLicense(p)
  const licenseText = readLicenseText(dir)
  visited.set(key, {
    name: p.name,
    version: p.version,
    license,
    direct,
    repository: normalizeRepoUrl(p.repository) || p.homepage || '',
    licenseText
  })

  for (const dep of Object.keys(p.dependencies || {})) {
    queue.push({ name: dep, from: dir, direct: false })
  }
}

// Add Electron runtime itself explicitly (installer helper deps of the `electron` npm wrapper are not bundled)
const electronDir = resolvePkgDir('electron', rootDir)
if (electronDir) {
  const ep = JSON.parse(fs.readFileSync(path.join(electronDir, 'package.json'), 'utf8'))
  visited.set(`electron@${ep.version}`, {
    name: ep.name,
    version: ep.version,
    license: normalizeLicense(ep),
    direct: true,
    repository: normalizeRepoUrl(ep.repository),
    licenseText: readLicenseText(electronDir)
  })
}

const packages = Array.from(visited.values()).sort((a, b) => {
  if (a.direct !== b.direct) return a.direct ? -1 : 1
  return a.name.localeCompare(b.name)
})

// Verify 100% MIT compatibility
const incompatible = packages.filter((p) => !ALLOWED_LICENSES.has(p.license))
if (incompatible.length > 0) {
  console.error('Incompatible or unknown runtime licenses detected:')
  for (const p of incompatible) {
    console.error(`  - ${p.name}@${p.version}: ${p.license}`)
  }
  process.exit(1)
}

const lines = []
lines.push('# Third-Party Software Notices and Licenses')
lines.push('')
lines.push('MultiplexIDE is licensed under the **MIT License** (see [LICENSE](LICENSE)).')
lines.push('This application incorporates open-source third-party software components under permissive licenses (MIT, ISC, BSD, Unlicense) that are fully compatible with the MIT License. In accordance with their respective license terms, the copyright notices and license texts of all bundled runtime components are reproduced below.')
lines.push('')
lines.push('> Auto-generated from installed runtime dependencies via `npm run licenses:generate`.')
lines.push('')
lines.push('## Summary of Runtime Components')
lines.push('')
lines.push('| Package | Version | License | Scope | Source |')
lines.push('| :--- | :--- | :--- | :--- | :--- |')
for (const p of packages) {
  const scope = p.direct ? 'Direct' : 'Transitive'
  const link = p.repository ? `[Link](${p.repository})` : '—'
  lines.push(`| \`${p.name}\` | \`${p.version}\` | ${p.license} | ${scope} | ${link} |`)
}
lines.push('')
lines.push('## Electron, Chromium, V8, and Node.js')
lines.push('')
lines.push('Packaged desktop builds of MultiplexIDE distribute the Electron runtime (MIT License), which embeds Chromium, V8, and Node.js. Complete Chromium and subcomponent notices are automatically included in packaged builds as `LICENSES.chromium.html` alongside Electron\'s `LICENSE` file.')
lines.push('')
lines.push('## Trademarks & Design Inspiration')
lines.push('')
lines.push('- **MultiplexIDE** is an independent open-source project and is not affiliated with, endorsed by, or sponsored by **Sublime HQ Pty Ltd** (Sublime Text), **Microsoft Corporation** (Visual Studio Code), or **Manaflow AI** (cmux).')
lines.push('- All product names, logos, and brands mentioned in documentation are property of their respective owners.')
lines.push('- Built-in color themes inspired by classic editor palettes (Monokai, Mariana, Boxy Dark) are original clean-room theme definitions.')
lines.push('')
lines.push('---')
lines.push('')
lines.push('## Full Third-Party License Texts')
lines.push('')

for (const p of packages) {
  lines.push(`### ${p.name} (${p.version}) — ${p.license}`)
  if (p.repository) {
    lines.push(`Repository: ${p.repository}`)
  }
  lines.push('')
  lines.push('```text')
  lines.push(p.licenseText || `Licensed under ${p.license} (see package metadata).`)
  lines.push('```')
  lines.push('')
}

const output = lines.join('\n')
const outPath = path.join(rootDir, 'THIRD_PARTY_NOTICES.md')

if (process.argv.includes('--check')) {
  if (!fs.existsSync(outPath)) {
    console.error('THIRD_PARTY_NOTICES.md is missing. Run `npm run licenses:generate`.')
    process.exit(1)
  }
  const current = fs.readFileSync(outPath, 'utf8')
  if (current !== output) {
    console.error('THIRD_PARTY_NOTICES.md is out of date. Run `npm run licenses:generate`.')
    process.exit(1)
  }
  console.log(`License compliance OK: ${packages.length} runtime packages verified (all permissive / MIT-compatible).`)
  process.exit(0)
}

fs.writeFileSync(outPath, output, 'utf8')
console.log(`Generated THIRD_PARTY_NOTICES.md for ${packages.length} runtime packages (all MIT-compatible).`)
