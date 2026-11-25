import type * as monaco from 'monaco-editor'
import type { Terminal as XTerm } from '@xterm/xterm'
import { decodeOsc52Payload } from '@shared/osc52'
import { useAppStore } from '@renderer/stores/useAppStore'

export { decodeOsc52Payload }
export type ClipboardAction = 'cut' | 'copy' | 'paste' | 'selectAll'

const terminalInstances = new Map<string, XTerm>()
const monacoEditors = new Map<string, monaco.editor.ICodeEditor>()

export function registerTerminalInstance(terminalId: string, term: XTerm): void {
  terminalInstances.set(terminalId, term)
}

export function unregisterTerminalInstance(terminalId: string, term?: XTerm): void {
  if (!term || terminalInstances.get(terminalId) === term) {
    terminalInstances.delete(terminalId)
  }
}

export function registerMonacoEditor(key: string, editor: monaco.editor.ICodeEditor): void {
  monacoEditors.set(key, editor)
}

export function unregisterMonacoEditor(key: string, editor?: monaco.editor.ICodeEditor): void {
  if (!editor || monacoEditors.get(key) === editor) {
    monacoEditors.delete(key)
  }
}

/**
 * Bridges navigator.clipboard directly onto Electron's native system clipboard
 * so Monaco context-menu Paste/Copy and any web clipboard calls work reliably
 * on both dev (http://) and packaged macOS builds (file://).
 */
export function installSystemClipboardPolyfill(): void {
  if (typeof window === 'undefined' || !window.multiplex) return
  try {
    const nativeBridge = {
      readText: async () => window.multiplex.readClipboardText(),
      writeText: async (text: string) => {
        window.multiplex.writeClipboardText(text)
      }
    }
    if (navigator.clipboard) {
      try {
        Object.defineProperty(navigator.clipboard, 'readText', {
          value: nativeBridge.readText,
          configurable: true
        })
        Object.defineProperty(navigator.clipboard, 'writeText', {
          value: nativeBridge.writeText,
          configurable: true
        })
        return
      } catch {
        // Fallback to replacing navigator.clipboard property below
      }
    }
    Object.defineProperty(navigator, 'clipboard', {
      value: nativeBridge,
      configurable: true
    })
  } catch {
    // Ignore if environment freezes navigator.clipboard
  }
}

function getActiveMonacoEditor(): monaco.editor.ICodeEditor | null {
  for (const ed of monacoEditors.values()) {
    try {
      if (ed.hasTextFocus()) return ed
    } catch {
      // ignore disposed editor
    }
  }
  const state = useAppStore.getState()
  const preferredKey = state.editorColumns === 2 && state.editorFocusGroup === 1 ? 'pane-1' : 'pane-0'
  return monacoEditors.get(preferredKey) || monacoEditors.get('pane-0') || null
}

function extractMonacoCopyText(ed: monaco.editor.ICodeEditor): { text: string; isWholeLine: boolean } {
  const model = ed.getModel()
  if (!model) return { text: '', isWholeLine: false }
  const selections = ed.getSelections() || []
  if (selections.length === 0) return { text: '', isWholeLine: false }

  const allEmpty = selections.every((s) => s.isEmpty())
  if (allEmpty) {
    const eol = model.getEOL()
    const seenLines = new Set<number>()
    const lines: string[] = []
    for (const sel of selections) {
      if (!seenLines.has(sel.positionLineNumber)) {
        seenLines.add(sel.positionLineNumber)
        lines.push(model.getLineContent(sel.positionLineNumber))
      }
    }
    return { text: lines.join(eol) + eol, isWholeLine: true }
  }

  const parts = selections.map((s) => model.getValueInRange(s))
  return { text: parts.join('\n'), isWholeLine: false }
}

function performMonacoEditAction(ed: monaco.editor.ICodeEditor, action: ClipboardAction): void {
  const model = ed.getModel()
  if (!model) return

  if (action === 'selectAll') {
    ed.trigger('clipboard-bridge', 'editor.action.selectAll', null)
    return
  }

  if (action === 'copy') {
    const { text } = extractMonacoCopyText(ed)
    if (text) {
      window.multiplex.writeClipboardText(text)
    }
    return
  }

  if (action === 'cut') {
    const { text, isWholeLine } = extractMonacoCopyText(ed)
    if (text) {
      window.multiplex.writeClipboardText(text)
    }
    // Check readOnly option (id 94 in Monaco EditorOption, or use raw options safely)
    const opts = ed.getRawOptions()
    if (opts.readOnly) return

    const selections = ed.getSelections() || []
    if (selections.length === 0) return

    if (isWholeLine) {
      ed.trigger('clipboard-bridge', 'editor.action.deleteLines', null)
      return
    }

    const edits = selections
      .filter((s) => !s.isEmpty())
      .map((range) => ({ range, text: '', forceMoveMarkers: true }))
    if (edits.length > 0) {
      ed.pushUndoStop()
      ed.executeEdits('clipboard-cut', edits)
      ed.pushUndoStop()
    }
    return
  }

  if (action === 'paste') {
    const opts = ed.getRawOptions()
    if (opts.readOnly) return
    const text = window.multiplex.readClipboardText()
    if (!text) return
    ed.focus()
    ed.trigger('clipboard-bridge', 'paste', {
      text,
      pasteOnNewLine: false,
      multicursorText: null,
      mode: null
    })
  }
}

/**
 * Central dispatcher for macOS Edit menu / Cmd+C / Cmd+X / Cmd+V / Cmd+A.
 * Guarantees 100% bi-directional sync with macOS NSPasteboard across:
 * 1) Standard inputs & Monaco find widgets
 * 2) xterm.js WebGL terminals (reading/writing term selection & bracketed paste)
 * 3) Monaco code & diff editors
 * 4) General selectable DOM text (search results, errors, etc.)
 */
export function handleClipboardAction(action: ClipboardAction): void {
  const activeEl = document.activeElement as HTMLElement | null
  const isXtermEl = Boolean(activeEl?.closest('.xterm'))
  const isMonacoWidgetInput = Boolean(
    activeEl?.closest('.monaco-editor .find-widget, .monaco-editor .rename-box, .monaco-inputbox')
  )
  const isMonacoEl = Boolean(activeEl?.closest('.monaco-editor')) && !isMonacoWidgetInput
  const isStandardEditable =
    Boolean(activeEl) &&
    !isXtermEl &&
    !isMonacoEl &&
    (activeEl!.tagName === 'INPUT' || activeEl!.tagName === 'TEXTAREA' || activeEl!.isContentEditable)

  // 1. Standard text inputs, textareas, and Monaco find/replace inputs -> native Chromium edit
  if (isStandardEditable || isMonacoWidgetInput) {
    window.multiplex.execNativeEdit(action)
    return
  }

  const state = useAppStore.getState()

  // 2. xterm.js Terminal
  const shouldTargetTerminal =
    isXtermEl || (!isMonacoEl && (state.activeFocusArea === 'terminal' || state.layoutMode === 'terminal'))

  if (shouldTargetTerminal && state.focusedTerminalId) {
    const term = terminalInstances.get(state.focusedTerminalId)
    if (term) {
      if (action === 'copy' || action === 'cut') {
        if (term.hasSelection()) {
          window.multiplex.writeClipboardText(term.getSelection())
        } else {
          const domSel = window.getSelection()?.toString()
          if (domSel) window.multiplex.writeClipboardText(domSel)
        }
        return
      }
      if (action === 'paste') {
        const text = window.multiplex.readClipboardText()
        if (text) {
          term.paste(text)
          term.focus()
        }
        return
      }
      if (action === 'selectAll') {
        term.selectAll()
        return
      }
    }
  }

  // 3. Monaco Code / Diff Editor
  if (isMonacoEl || state.activeFocusArea === 'editor') {
    const ed = getActiveMonacoEditor()
    if (ed) {
      performMonacoEditAction(ed, action)
      return
    }
  }

  // 4. Fallback for general selectable text (e.g. Global Search matches)
  if (action === 'copy') {
    const domSel = window.getSelection()?.toString()
    if (domSel) {
      window.multiplex.writeClipboardText(domSel)
      return
    }
  }
  window.multiplex.execNativeEdit(action)
}
