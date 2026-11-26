/**
 * Pure iTerm2-style macOS terminal keymapping & multi-line paste safety helpers.
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
