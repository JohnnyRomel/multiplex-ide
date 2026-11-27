import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import type { EditorThemeId } from '@shared/types'
import { registerEnhancedSyntaxHighlighting } from './languages'
import { openReferencesOverlayForEditor, registerCodeIntelligence } from './codeIntel'

let initialized = false

export function initMonacoSublime(): void {
  if (initialized) return
  initialized = true

  ;(self as any).MonacoEnvironment = {
    getWorker(_: unknown, label: string) {
      if (label === 'json') return new jsonWorker()
      if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
      if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
      if (label === 'typescript' || label === 'javascript') return new tsWorker()
      return new editorWorker()
    }
  }

  // Install rich non-LSP Sublime Text 3-style syntax rules for C/C++, Python & Shell
  registerEnhancedSyntaxHighlighting()
  // Register non-LSP Hover References, C++ Go-to-Definition, Document Highlights & Outline
  registerCodeIntelligence()

  // 1. Classic Sublime Text 3 Monokai
  monaco.editor.defineTheme('sublime-monokai', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'F8F8F2', background: '272822' },
      { token: 'comment', foreground: '75715E', fontStyle: 'italic' },
      { token: 'comment.todo', foreground: 'FD971F', fontStyle: 'bold italic' },
      { token: 'keyword', foreground: 'F92672' },
      { token: 'keyword.directive', foreground: 'F92672' },
      { token: 'operator', foreground: 'F92672' },
      { token: 'string', foreground: 'E6DB74' },
      { token: 'string.quote', foreground: 'E6DB74' },
      { token: 'string.include', foreground: 'E6DB74' },
      { token: 'string.escape', foreground: 'AE81FF' },
      { token: 'number', foreground: 'AE81FF' },
      { token: 'constant', foreground: 'AE81FF' },
      { token: 'constant.language', foreground: 'AE81FF' },
      { token: 'type', foreground: '66D9EF', fontStyle: 'italic' },
      { token: 'type.identifier', foreground: '66D9EF' },
      { token: 'namespace', foreground: 'A1EFE4' },
      { token: 'class', foreground: 'A6E22E' },
      { token: 'function', foreground: 'A6E22E' },
      { token: 'entity.name.function', foreground: 'A6E22E' },
      { token: 'support.function', foreground: '66D9EF' },
      { token: 'support.function.magic', foreground: '66D9EF', fontStyle: 'italic' },
      { token: 'annotation', foreground: 'A6E22E' },
      { token: 'variable.language', foreground: 'FD971F', fontStyle: 'italic' },
      { token: 'variable.parameter', foreground: 'FD971F', fontStyle: 'italic' },
      { token: 'variable.property', foreground: 'F8F8F2' },
      { token: 'identifier', foreground: 'F8F8F2' },
      { token: 'variable', foreground: 'F8F8F2' },
      { token: 'tag', foreground: 'F92672' },
      { token: 'attribute.name', foreground: 'A6E22E' },
      { token: 'attribute.value', foreground: 'E6DB74' },
      { token: 'delimiter', foreground: 'F8F8F2' },
      { token: 'regexp', foreground: 'E6DB74' }
    ],
    colors: {
      'editor.background': '#272822',
      'editor.foreground': '#f8f8f2',
      'editor.lineHighlightBackground': '#3e3d32',
      'editor.lineHighlightBorder': '#3e3d3200',
      'editor.selectionBackground': '#49483e',
      'editor.inactiveSelectionBackground': '#3b3a32',
      'editorCursor.foreground': '#f8f8f0',
      'editorWhitespace.foreground': '#464741',
      'editorIndentGuide.background1': '#3b3c35',
      'editorIndentGuide.activeBackground1': '#64655c',
      'editorLineNumber.foreground': '#8f908a',
      'editorLineNumber.activeForeground': '#f8f8f2',
      'editorGutter.background': '#272822',
      'editorWidget.background': '#1d1e1a',
      'editorWidget.border': '#11120e',
      'editorHoverWidget.background': '#1d1e1a',
      'editorHoverWidget.border': '#383930',
      'editorHoverWidget.foreground': '#f8f8f2',
      'editor.wordHighlightBackground': '#a6e22e22',
      'editor.wordHighlightStrongBackground': '#66d9ef30',
      'editor.wordHighlightBorder': '#a6e22e44',
      'editorSuggestWidget.background': '#1d1e1a',
      'editorSuggestWidget.border': '#11120e',
      'editorSuggestWidget.selectedBackground': '#34352e',
      'minimap.background': '#24251f',
      'minimapSlider.background': '#f8f8f214',
      'minimapSlider.hoverBackground': '#f8f8f228',
      'diffEditor.insertedTextBackground': '#a6e22e22',
      'diffEditor.removedTextBackground': '#f9267222',
      'scrollbar.shadow': '#00000000',
      'scrollbarSlider.background': '#f8f8f218',
      'scrollbarSlider.hoverBackground': '#f8f8f230'
    }
  })

  // 2. Sublime Text 3.2+ Mariana
  monaco.editor.defineTheme('sublime-mariana', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'D8DEE9', background: '303841' },
      { token: 'comment', foreground: '65737E', fontStyle: 'italic' },
      { token: 'comment.todo', foreground: 'FAC863', fontStyle: 'bold italic' },
      { token: 'keyword', foreground: 'C594C5' },
      { token: 'keyword.directive', foreground: 'EC5F67' },
      { token: 'keyword.operator', foreground: 'F97B58' },
      { token: 'operator', foreground: 'F97B58' },
      { token: 'string', foreground: '99C794' },
      { token: 'string.quote', foreground: '99C794' },
      { token: 'string.include', foreground: '99C794' },
      { token: 'string.escape', foreground: '5FB3B3' },
      { token: 'number', foreground: 'F9AE58' },
      { token: 'constant', foreground: 'EC5F67' },
      { token: 'constant.language', foreground: 'EC5F67' },
      { token: 'type', foreground: 'C594C5', fontStyle: 'italic' },
      { token: 'type.identifier', foreground: 'FAC863' },
      { token: 'namespace', foreground: '5FB3B3' },
      { token: 'class', foreground: 'FAC863' },
      { token: 'function', foreground: '6699CC' },
      { token: 'entity.name.function', foreground: '6699CC' },
      { token: 'support.function', foreground: '5FB3B3' },
      { token: 'support.function.magic', foreground: '5FB3B3', fontStyle: 'italic' },
      { token: 'annotation', foreground: 'FAC863' },
      { token: 'variable.language', foreground: 'EC5F67', fontStyle: 'italic' },
      { token: 'variable.property', foreground: 'D8DEE9' },
      { token: 'identifier', foreground: 'D8DEE9' },
      { token: 'variable', foreground: 'D8DEE9' },
      { token: 'tag', foreground: 'EC5F67' },
      { token: 'attribute.name', foreground: 'C594C5' },
      { token: 'attribute.value', foreground: '99C794' },
      { token: 'delimiter', foreground: '5FB3B3' },
      { token: 'regexp', foreground: '5FB3B3' }
    ],
    colors: {
      'editor.background': '#303841',
      'editor.foreground': '#d8dee9',
      'editor.lineHighlightBackground': '#3b444f',
      'editor.lineHighlightBorder': '#3b444f00',
      'editor.selectionBackground': '#4e5a65',
      'editor.inactiveSelectionBackground': '#404b56',
      'editorCursor.foreground': '#f9ae58',
      'editorIndentGuide.background1': '#3d4652',
      'editorIndentGuide.activeBackground1': '#5b6878',
      'editorLineNumber.foreground': '#6e7c8a',
      'editorLineNumber.activeForeground': '#d8dee9',
      'editorGutter.background': '#303841',
      'editorWidget.background': '#242a32',
      'editorWidget.border': '#15191f',
      'editorHoverWidget.background': '#222830',
      'editorHoverWidget.border': '#3b4552',
      'editorHoverWidget.foreground': '#d8dee9',
      'editor.wordHighlightBackground': '#5fb3b324',
      'editor.wordHighlightStrongBackground': '#fac86330',
      'editor.wordHighlightBorder': '#5fb3b344',
      'minimap.background': '#2d353e',
      'minimapSlider.background': '#d8dee914',
      'minimapSlider.hoverBackground': '#d8dee928',
      'diffEditor.insertedTextBackground': '#99c79424',
      'diffEditor.removedTextBackground': '#ec5f6724',
      'scrollbar.shadow': '#00000000',
      'scrollbarSlider.background': '#d8dee918',
      'scrollbarSlider.hoverBackground': '#d8dee930'
    }
  })

  // 3. Sublime Boxy Tomorrow / One Dark
  monaco.editor.defineTheme('sublime-boxy', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'ABB2BF', background: '282C34' },
      { token: 'comment', foreground: '5C6370', fontStyle: 'italic' },
      { token: 'comment.todo', foreground: 'E5C07B', fontStyle: 'bold italic' },
      { token: 'keyword', foreground: 'C678DD' },
      { token: 'keyword.directive', foreground: 'C678DD' },
      { token: 'operator', foreground: '56B6C2' },
      { token: 'string', foreground: '98C379' },
      { token: 'string.quote', foreground: '98C379' },
      { token: 'string.include', foreground: '98C379' },
      { token: 'string.escape', foreground: '56B6C2' },
      { token: 'number', foreground: 'D19A66' },
      { token: 'constant', foreground: 'D19A66' },
      { token: 'constant.language', foreground: 'D19A66' },
      { token: 'type', foreground: 'E5C07B' },
      { token: 'type.identifier', foreground: 'E5C07B' },
      { token: 'namespace', foreground: '56B6C2' },
      { token: 'function', foreground: '61AFEF' },
      { token: 'entity.name.function', foreground: '61AFEF' },
      { token: 'support.function', foreground: '56B6C2' },
      { token: 'support.function.magic', foreground: '56B6C2', fontStyle: 'italic' },
      { token: 'annotation', foreground: 'D19A66' },
      { token: 'variable.language', foreground: 'E06C75', fontStyle: 'italic' },
      { token: 'variable.property', foreground: 'E06C75' },
      { token: 'tag', foreground: 'E06C75' },
      { token: 'attribute.name', foreground: 'D19A66' },
      { token: 'attribute.value', foreground: '98C379' }
    ],
    colors: {
      'editor.background': '#282c34',
      'editor.foreground': '#abb2bf',
      'editor.lineHighlightBackground': '#2c313c',
      'editor.lineHighlightBorder': '#2c313c00',
      'editor.selectionBackground': '#3e4451',
      'editorCursor.foreground': '#528bff',
      'editorLineNumber.foreground': '#5c6370',
      'editorLineNumber.activeForeground': '#abb2bf',
      'editorGutter.background': '#282c34',
      'editorWidget.background': '#1d1f25',
      'editorWidget.border': '#121417',
      'editorHoverWidget.background': '#1b1e24',
      'editorHoverWidget.border': '#333842',
      'editorHoverWidget.foreground': '#dcdfe4',
      'editor.wordHighlightBackground': '#61afef24',
      'editor.wordHighlightStrongBackground': '#98c37930',
      'editor.wordHighlightBorder': '#61afef44',
      'minimap.background': '#252931',
      'minimapSlider.background': '#abb2bf14',
      'minimapSlider.hoverBackground': '#abb2bf28',
      'scrollbar.shadow': '#00000000',
      'scrollbarSlider.background': '#abb2bf18',
      'scrollbarSlider.hoverBackground': '#abb2bf30'
    }
  })
}

export function getMonacoThemeName(theme: EditorThemeId): string {
  if (theme === 'mariana') return 'sublime-mariana'
  if (theme === 'boxy') return 'sublime-boxy'
  return 'sublime-monokai'
}

export function bindSublimeKeybindings(
  editor: monaco.editor.IStandaloneCodeEditor,
  callbacks: {
    onSave: () => void
    onSwitchHeaderSource?: () => void
    onNavigateBack?: () => void
    onNavigateForward?: () => void
  }
): void {
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    callbacks.onSave()
  })
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyD, () => {
    editor.trigger('sublime', 'editor.action.copyLinesDownAction', null)
  })
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL, () => {
    editor.trigger('sublime', 'expandLineSelection', null)
  })
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyK, () => {
    editor.trigger('sublime', 'editor.action.deleteLines', null)
  })
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.WinCtrl | monaco.KeyCode.UpArrow, () => {
    editor.trigger('sublime', 'editor.action.moveLinesUpAction', null)
  })
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.WinCtrl | monaco.KeyCode.DownArrow, () => {
    editor.trigger('sublime', 'editor.action.moveLinesDownAction', null)
  })
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyL, () => {
    editor.trigger('sublime', 'editor.action.insertCursorAtEndOfEachLineSelected', null)
  })

  // Sublime `⌘R` & VS Code `⌘⇧O` -> Goto Symbol in File (functions, classes, macros)
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyR, () => {
    editor.trigger('code-intel', 'editor.action.quickOutline', null)
  })
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyO, () => {
    editor.trigger('code-intel', 'editor.action.quickOutline', null)
  })

  // `⇧F12` -> Interactive Workspace References & Definitions Overlay
  editor.addAction({
    id: 'mide.action.findReferences',
    label: 'Find All References',
    keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F12],
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 1.5,
    run: (ed) => {
      void openReferencesOverlayForEditor(ed)
    }
  })

  // `⌥⌘O` -> Switch C/C++ Header / Source (`.h` ↔ `.cpp`)
  if (callbacks.onSwitchHeaderSource) {
    const fn = callbacks.onSwitchHeaderSource
    editor.addAction({
      id: 'mide.action.switchHeaderSource',
      label: 'Switch Header / Source (.h ↔ .cpp)',
      keybindings: [monaco.KeyMod.Alt | monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyO],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.8,
      run: () => fn()
    })
  }

  // `⌃-` / `⌃⇧-` -> Navigate Back / Forward (classic VS Code / Xcode jump history!)
  if (callbacks.onNavigateBack) {
    const back = callbacks.onNavigateBack
    editor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.Minus, () => back())
  }
  if (callbacks.onNavigateForward) {
    const fwd = callbacks.onNavigateForward
    editor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyMod.Shift | monaco.KeyCode.Minus, () => fwd())
  }
}
