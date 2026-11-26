/**
 * Pure iTerm2-style macOS terminal keymapping, clipboard cleanup, and paste safety helpers.
 * Kept pure in `src/shared/` so all edge cases are covered by unit tests.
 */

export interface KeyEventLike {
  type: string
  key: string
  code?: string
  metaKey: boolean
  altKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  isComposing?: boolean
  keyCode?: number
}

/**
 * Maps iTerm2 "Natural Text Editing" & modern AI-CLI (`agy`, Claude, Ink) macOS keystrokes
 * to standard terminal escape sequences.
 * Returns `null` when xterm.js should handle the key natively.
 */
export function mapIterm2KeyEvent(ev: KeyEventLike): string | null {
  if (ev.type !== 'keydown') return null
  // Never intercept active IME composition (Chinese Pinyin / Japanese / Korean preedit)
  if (ev.isComposing || ev.keyCode === 229) return null

  // Shift+Enter -> Esc+CR (`\x1b\r`), inserting a newline inside `agy` / Ink / zsh multi-line prompts
  if (ev.shiftKey && !ev.metaKey && !ev.altKey && !ev.ctrlKey && ev.key === 'Enter') {
    return '\x1b\r'
  }

  // Cmd + Left / Right / Backspace (macOS Natural Text Editing)
  if (ev.metaKey && !ev.altKey && !ev.ctrlKey && !ev.shiftKey) {
    if (ev.key === 'ArrowLeft') return '\x01' // Ctrl+A: beginning of line
    if (ev.key === 'ArrowRight') return '\x05' // Ctrl+E: end of line
    if (ev.key === 'Backspace') return '\x15' // Ctrl+U: kill to start of line
  }

  // Option + Left / Right / Backspace (word navigation & backward word delete)
  if (ev.altKey && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey) {
    if (ev.key === 'ArrowLeft') return '\x1bb' // Esc+b: backward word
    if (ev.key === 'ArrowRight') return '\x1bf' // Esc+f: forward word
    if (ev.key === 'Backspace') return '\x1b\x7f' // Esc+DEL: backward kill word
  }

  return null
}

export interface PasteSafetyResult {
  safe: boolean
  lineCount: number
  preview: string
}

/**
 * iTerm2-style multi-line paste safety check:
 * - When `bracketedPasteMode` is enabled (zsh, agy, vim, tmux), pasting multi-line text is safe
 *   because the shell/TUI buffers it without auto-executing newlines -> returns `safe: true`.
 * - When `bracketedPasteMode` is OFF (raw sh, old bash, REPLs, sql clients) and the clipboard
 *   contains newlines, warns before executing commands line-by-line!
 */
export function analyzePasteSafety(text: string, bracketedPasteMode: boolean): PasteSafetyResult {
  if (!text) return { safe: true, lineCount: 0, preview: '' }
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const hasNewline = normalized.includes('\n')
  if (!hasNewline || bracketedPasteMode) {
    return { safe: true, lineCount: 1, preview: normalized.slice(0, 80) }
  }
  const lines = normalized.split('\n')
  const nonEmptyTrailingTrimmed = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
  const lineCount = Math.max(1, nonEmptyTrailingTrimmed.length)
  // A single trailing newline on 1 command still executes immediately when bracketed paste is off
  const firstLine = (nonEmptyTrailingTrimmed[0] || '').trim()
  const preview = firstLine.length > 64 ? `${firstLine.slice(0, 61)}...` : firstLine
  return {
    safe: false,
    lineCount: hasNewline && nonEmptyTrailingTrimmed.length === 1 ? 2 : lineCount,
    preview
  }
}

/** Flattens a multi-line clipboard snippet into a single space-joined line for safe pasting. */
export function flattenPasteToSingleLine(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
}

/**
 * Strips Bracketed Paste escape-injection markers (`\x1b[200~`, `\x1b[201~`) and NUL bytes
 * before pasting into a terminal so clipboard content can never break out of bracketed paste mode.
 */
export function sanitizePasteText(text: string): string {
  if (!text) return ''
  return text.replace(/\x1b\[20[01]~/g, '').replace(/\x00/g, '')
}

/**
 * iTerm2-style copy cleanup:
 * - `trimTrailingSpaces`: strips trailing spaces/tabs per line (common from tmux/TUI padding)
 *   while preserving leading indentation and line structure.
 * - `joinLines`: unwraps hard-wrapped terminal lines cleanly (joins without extra space for
 *   wrapped URLs/paths/tokens, or with a single space for normal commands/text).
 */
export function cleanCopiedText(
  text: string,
  opts?: { trimTrailingSpaces?: boolean; joinLines?: boolean }
): string {
  if (!text) return ''
  const normalized = text.replace(/\r\n/g, '\n')
  if (opts?.joinLines) {
    const lines = normalized
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    if (lines.length <= 1) return lines[0] || ''
    const isUnbrokenToken =
      /^(https?:\/\/|ssh:\/\/|git@|\/|~\/)/.test(lines[0]) && lines.every((l) => !/\s/.test(l))
    if (isUnbrokenToken) {
      return lines.join('')
    }
    let out = lines[0]
    for (let i = 1; i < lines.length; i++) {
      const prev = out
      const cur = lines[i]
      // Avoid inserting a space after path/URL/flag separators if line broke right on them
      if (/[\/=:\-_?&]$/.test(prev) && !/^\s/.test(cur)) {
        out += cur
      } else {
        out += ' ' + cur
      }
    }
    return out
  }
  if (opts?.trimTrailingSpaces !== false) {
    return normalized
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/g, ''))
      .join('\n')
  }
  return normalized
}

/**
 * Splits a large terminal paste into safe PTY-buffer-sized chunks (`<= 1024` chars) without
 * breaking UTF-16 surrogate pairs (emoji / CJK Extension B) or bracketed paste escape markers.
 */
export function splitIntoPtyChunks(data: string, maxChunkChars = 1024): string[] {
  if (!data) return []
  const limit = Math.max(64, maxChunkChars)
  if (data.length <= limit) return [data]

  const chunks: string[] = []
  let i = 0
  while (i < data.length) {
    let end = Math.min(data.length, i + limit)
    if (end < data.length) {
      // Never split a UTF-16 surrogate pair (high surrogate 0xD800..0xDBFF at `end - 1`)
      const prevCode = data.charCodeAt(end - 1)
      if (prevCode >= 0xd800 && prevCode <= 0xdbff && end > i + 1) {
        end -= 1
      }
      // Avoid splitting right inside a short trailing `\x1b[200~` / `\x1b[201~` sequence
      const lookbackStart = Math.max(i, end - 7)
      const escIdx = data.lastIndexOf('\x1b', end - 1)
      if (escIdx >= lookbackStart && escIdx > i) {
        end = escIdx
      }
    }
    chunks.push(data.slice(i, end))
    i = end
  }
  return chunks
}

/**
 * Extracts POSIX file paths from macOS `NSFilenamesPboardType` XML plist pasteboard buffers
 * (used when user hits ⌘C on files in Finder and ⌘V inside a terminal).
 */
export function parseMacOsFilenamesPlist(rawXml: string): string[] {
  if (!rawXml || !rawXml.includes('<string>')) return []
  const paths: string[] = []
  const re = /<string>([\s\S]*?)<\/string>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(rawXml)) !== null) {
    const decoded = m[1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .trim()
    if (decoded.startsWith('/')) {
      paths.push(decoded)
    }
  }
  return paths
}
