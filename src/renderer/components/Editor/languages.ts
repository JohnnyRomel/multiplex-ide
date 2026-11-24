import * as monaco from 'monaco-editor'
import { enhancedCppLanguage, enhancedPythonLanguage } from '@shared/syntaxGrammars'

export const enhancedCppConf: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')']
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"', notIn: ['string'] },
    { open: "'", close: "'", notIn: ['string', 'comment'] }
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: '<', close: '>' }
  ]
}

export const enhancedPythonConf: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '#' },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')']
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"', notIn: ['string'] },
    { open: "'", close: "'", notIn: ['string', 'comment'] }
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" }
  ],
  onEnterRules: [
    {
      beforeText: /^\s*(?:def|class|for|if|elif|else|while|try|with|finally|except|async|match|case)\b.*:\s*$/,
      action: { indentAction: monaco.languages.IndentAction.Indent }
    }
  ]
}

export function registerEnhancedSyntaxHighlighting(): void {
  const applyCpp = (langId: string) => {
    monaco.languages.setMonarchTokensProvider(langId, enhancedCppLanguage)
    monaco.languages.setLanguageConfiguration(langId, enhancedCppConf)
  }
  for (const langId of ['cpp', 'c']) {
    applyCpp(langId)
    monaco.languages.onLanguage(langId, () => {
      setTimeout(() => applyCpp(langId), 0)
    })
  }

  const applyPy = () => {
    monaco.languages.setMonarchTokensProvider('python', enhancedPythonLanguage)
    monaco.languages.setLanguageConfiguration('python', enhancedPythonConf)
  }
  applyPy()
  monaco.languages.onLanguage('python', () => {
    setTimeout(applyPy, 0)
  })
}
