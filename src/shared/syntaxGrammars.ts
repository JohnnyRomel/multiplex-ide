/**
 * Pure Non-LSP Sublime Text 3-style Monarch Grammar Definitions for C/C++ (incl. CUDA) and Python.
 * Highlight scopes:
 * - keyword / keyword.directive
 * - type / type.identifier
 * - namespace (std::, tiktok::monarch::)
 * - entity.name.function (definitions & calls)
 * - support.function / support.function.magic (__init__, len, move, make_shared)
 * - variable.language (self, cls, this)
 * - annotation (@dataclass, [[nodiscard]])
 * - constant / constant.language (MAX_BATCH_SIZE, nullptr, True, False, None)
 * - string / string.include / string.escape + Python f-string {interpolation}
 * - comment / comment.todo
 */
export const enhancedCppLanguage: any = {
  defaultToken: '',
  tokenPostfix: '.cpp',

  controlKeywords: [
    'if', 'else', 'switch', 'case', 'default', 'for', 'while', 'do', 'break', 'continue',
    'return', 'goto', 'try', 'catch', 'throw', 'co_await', 'co_return', 'co_yield',
    'new', 'delete', 'sizeof', 'alignof', 'decltype', 'typeid', 'noexcept',
    'static_cast', 'dynamic_cast', 'const_cast', 'reinterpret_cast',
    'public', 'private', 'protected', 'friend', 'using', 'namespace', 'template',
    'typename', 'requires', 'concept', 'operator', 'export', 'import', 'module',
    'static_assert', 'asm', '__asm__'
  ],

  storageKeywords: [
    'const', 'constexpr', 'consteval', 'constinit', 'volatile', 'mutable',
    'static', 'extern', 'register', 'thread_local', 'inline', '__inline__', '__forceinline',
    'virtual', 'override', 'final', 'explicit', 'typedef', 'struct', 'class', 'enum', 'union',
    '__global__', '__device__', '__host__', '__shared__', '__constant__', '__restrict__'
  ],

  typeKeywords: [
    'void', 'bool', 'char', 'char8_t', 'char16_t', 'char32_t', 'wchar_t',
    'short', 'int', 'long', 'signed', 'unsigned', 'float', 'double', 'auto',
    'int8_t', 'int16_t', 'int32_t', 'int64_t',
    'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
    'size_t', 'ssize_t', 'ptrdiff_t', 'intptr_t', 'uintptr_t', 'off_t',
    'half', 'bfloat16', '__half', '__nv_bfloat16',
    'string', 'wstring', 'u8string', 'u16string', 'u32string', 'string_view',
    'vector', 'array', 'deque', 'list', 'forward_list',
    'map', 'multimap', 'set', 'multiset',
    'unordered_map', 'unordered_multimap', 'unordered_set', 'unordered_multiset',
    'stack', 'queue', 'priority_queue', 'span',
    'pair', 'tuple', 'optional', 'variant', 'any', 'expected',
    'unique_ptr', 'shared_ptr', 'weak_ptr', 'function',
    'mutex', 'shared_mutex', 'recursive_mutex', 'lock_guard', 'unique_lock', 'shared_lock',
    'condition_variable', 'atomic', 'thread', 'jthread', 'future', 'promise',
    'ifstream', 'ofstream', 'fstream', 'stringstream', 'istringstream', 'ostringstream',
    'ostream', 'istream', 'iostream', 'exception', 'runtime_error', 'logic_error', 'invalid_argument'
  ],

  supportFunctions: [
    'move', 'forward', 'swap', 'make_pair', 'make_tuple', 'tie', 'get',
    'make_unique', 'make_shared', 'make_optional',
    'begin', 'end', 'rbegin', 'rend', 'cbegin', 'cend',
    'sort', 'find', 'find_if', 'count', 'count_if', 'transform', 'accumulate',
    'lower_bound', 'upper_bound', 'binary_search', 'min', 'max', 'clamp',
    'printf', 'fprintf', 'sprintf', 'snprintf', 'scanf', 'memcpy', 'memset', 'memmove', 'strlen',
    'malloc', 'calloc', 'realloc', 'free', 'assert'
  ],

  constants: [
    'true', 'false', 'nullptr', 'NULL', 'nullopt', 'npos',
    'stdin', 'stdout', 'stderr', 'EOF',
    'INT_MAX', 'INT_MIN', 'UINT_MAX', 'LLONG_MAX', 'LLONG_MIN', 'ULLONG_MAX', 'SIZE_MAX'
  ],

  languageVars: ['this'],

  escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[0-7]{1,3})/,

  tokenizer: {
    root: [
      [/^\s*#\s*include\b/, { token: 'keyword.directive', next: '@include' }],
      [/^\s*#\s*(?:define|undef|ifdef|ifndef|if|elif|else|endif|pragma|error|warning|line)\b/, 'keyword.directive'],

      [/\[\[\s*[a-zA-Z_][\w:,\s]*\]\]/, 'annotation'],

      { include: '@whitespace' },

      [/R"([a-zA-Z0-9_{}[\]#<>%:;.?*+\-/^&|~!=,']*)\(/, { token: 'string.quote', next: '@rawstring.$1' }],
      [/(?:u8|u|U|L)?"/, { token: 'string.quote', next: '@string' }],
      [/(?:u8|u|U|L)?'/, { token: 'string.quote', next: '@char' }],

      // Namespace prefix (std::, tiktok::monarch::)
      [/[a-zA-Z_]\w*(?=\s*::)/, 'namespace'],

      // Template function calls: make_shared<Foo>(...)
      [
        /[a-zA-Z_]\w*(?=\s*<[^;{}()=\n]{1,80}>\s*\()/,
        {
          cases: {
            '@controlKeywords': 'keyword',
            '@storageKeywords': 'keyword',
            '@typeKeywords': 'type',
            '@supportFunctions': 'support.function',
            '@default': 'entity.name.function'
          }
        }
      ],

      // Function / method definitions & calls
      [
        /[a-zA-Z_]\w*(?=\s*\()/,
        {
          cases: {
            '@controlKeywords': 'keyword',
            '@storageKeywords': 'keyword',
            '@typeKeywords': 'type',
            '@supportFunctions': 'support.function',
            '@constants': 'constant.language',
            '@default': 'entity.name.function'
          }
        }
      ],

      // ALL_CAPS constants / macros
      [/\b[A-Z][A-Z0-9_]{2,}\b/, 'constant'],

      // *_t types
      [/\b[a-z_][a-z0-9_]*_t\b/, 'type.identifier'],

      // PascalCase class / struct / enum identifiers
      [
        /\b[A-Z][a-zA-Z0-9_]*\b/,
        {
          cases: {
            '@constants': 'constant.language',
            '@typeKeywords': 'type',
            '@default': 'type.identifier'
          }
        }
      ],

      // Member access
      [/(?:->|\.)\s*[a-zA-Z_]\w*(?!\s*\()/, 'variable.property'],

      // Keywords, primitive types, constants, identifiers
      [
        /[a-zA-Z_]\w*/,
        {
          cases: {
            '@controlKeywords': 'keyword',
            '@storageKeywords': 'keyword',
            '@typeKeywords': 'type',
            '@supportFunctions': 'support.function',
            '@constants': 'constant.language',
            '@languageVars': 'variable.language',
            '@default': 'identifier'
          }
        }
      ],

      [/0[xX][0-9a-fA-F']+[uUlL]*/, 'number'],
      [/0[bB][01']+[uUlL]*/, 'number'],
      [/(?:\d[\d']*\.\d[\d']*|\.\d[\d']+)(?:[eE][+-]?\d[\d']*)?[fFlL]*/, 'number'],
      [/\d[\d']*[eE][+-]?\d[\d']*[fFlL]*/, 'number'],
      [/\d[\d']*[uUlL]*/, 'number'],

      [/[{}()[\]]/, '@brackets'],
      [/::|->|\.\.\.|<<=|>>=|<<|>>|<=|>=|==|!=|&&|\|\||\+\+|--|[+\-*/%&|^~!=<>]=?/, 'operator'],
      [/[;,.?:]/, 'delimiter']
    ],

    include: [
      [/\s+/, 'white'],
      [/<[^>]+>/, { token: 'string.include', next: '@pop' }],
      [/"[^"]+"/, { token: 'string.include', next: '@pop' }],
      [/$/, '', '@pop']
    ],

    whitespace: [
      [/[ \t\r\n]+/, 'white'],
      [/\/\*/, 'comment', '@comment'],
      [/\/\//, 'comment', '@linecomment']
    ],

    linecomment: [
      [/\b(?:TODO|FIXME|NOTE|HACK|XXX)\b/, 'comment.todo'],
      [/[^TFAHNX\r\n]+/, 'comment'],
      [/[TFAHNX]/, 'comment'],
      [/$/, '', '@pop']
    ],

    comment: [
      [/\b(?:TODO|FIXME|NOTE|HACK|XXX)\b/, 'comment.todo'],
      [/[^/*TFAHNX]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[/*TFAHNX]/, 'comment']
    ],

    string: [
      [/[^\\"]+/, 'string'],
      [/@escapes/, 'string.escape'],
      [/\\./, 'string.escape'],
      [/"/, { token: 'string.quote', next: '@pop' }]
    ],

    char: [
      [/[^\\']+/, 'string'],
      [/@escapes/, 'string.escape'],
      [/\\./, 'string.escape'],
      [/'/, { token: 'string.quote', next: '@pop' }]
    ],

    rawstring: [
      [
        /\)([a-zA-Z0-9_{}[\]#<>%:;.?*+\-/^&|~!=,']*)"/,
        {
          cases: {
            '$1==$S2': { token: 'string.quote', next: '@pop' },
            '@default': 'string'
          }
        }
      ],
      [/[^)]+/, 'string'],
      [/\)/, 'string']
    ]
  }
}

export const enhancedPythonLanguage: any = {
  defaultToken: '',
  tokenPostfix: '.python',

  keywords: [
    'and', 'as', 'assert', 'async', 'await', 'break', 'case', 'class', 'continue',
    'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global',
    'if', 'import', 'in', 'is', 'lambda', 'match', 'nonlocal', 'not', 'or',
    'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'
  ],

  builtinFunctions: [
    'abs', 'aiter', 'all', 'anext', 'any', 'ascii', 'bin', 'breakpoint', 'callable',
    'chr', 'compile', 'delattr', 'dir', 'divmod', 'enumerate', 'eval', 'exec',
    'filter', 'format', 'getattr', 'globals', 'hasattr', 'hash', 'help', 'hex',
    'id', 'input', 'isinstance', 'issubclass', 'iter', 'len', 'locals', 'map',
    'max', 'min', 'next', 'oct', 'open', 'ord', 'pow', 'print', 'repr', 'reversed',
    'round', 'setattr', 'sorted', 'sum', 'super', 'vars', 'zip', '__import__'
  ],

  typeKeywords: [
    'bool', 'bytearray', 'bytes', 'classmethod', 'complex', 'dict', 'float',
    'frozenset', 'int', 'list', 'memoryview', 'object', 'property', 'range',
    'set', 'slice', 'staticmethod', 'str', 'tuple', 'type',
    'Any', 'Optional', 'Union', 'List', 'Dict', 'Set', 'Tuple', 'Callable',
    'Sequence', 'Mapping', 'MutableMapping', 'Iterable', 'Iterator', 'Generator',
    'Type', 'TypeVar', 'Generic', 'Protocol', 'Literal', 'Final', 'ClassVar',
    'Annotated', 'TypedDict', 'NamedTuple', 'overload', 'dataclass',
    'Exception', 'BaseException', 'ValueError', 'TypeError', 'KeyError',
    'IndexError', 'AttributeError', 'RuntimeError', 'NotImplementedError',
    'OSError', 'IOError', 'FileNotFoundError', 'AssertionError', 'StopIteration'
  ],

  constants: ['True', 'False', 'None', 'Ellipsis', 'NotImplemented'],

  languageVars: ['self', 'cls'],

  escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[0-7]{1,3})/,

  tokenizer: {
    root: [
      { include: '@whitespace' },

      [/@[a-zA-Z_][\w.]*/, 'annotation'],

      [/(?:f|fr|rf)"""/i, { token: 'string.quote', next: '@fstringTripleDouble' }],
      [/(?:f|fr|rf)'''/i, { token: 'string.quote', next: '@fstringTripleSingle' }],
      [/(?:r|u|b|br|rb)?"""/i, { token: 'string.quote', next: '@stringTripleDouble' }],
      [/(?:r|u|b|br|rb)?'''/i, { token: 'string.quote', next: '@stringTripleSingle' }],
      [/(?:f|fr|rf)"/i, { token: 'string.quote', next: '@fstringDouble' }],
      [/(?:f|fr|rf)'/i, { token: 'string.quote', next: '@fstringSingle' }],
      [/(?:r|u|b|br|rb)?"/i, { token: 'string.quote', next: '@stringDouble' }],
      [/(?:r|u|b|br|rb)?'/i, { token: 'string.quote', next: '@stringSingle' }],

      [/__[a-zA-Z0-9_]+__/, 'support.function.magic'],

      [
        /\b[A-Z][a-zA-Z0-9_]*(?=\s*\()/,
        {
          cases: {
            '@typeKeywords': 'type',
            '@builtinFunctions': 'support.function',
            '@constants': 'constant.language',
            '@default': 'type.identifier'
          }
        }
      ],

      [
        /[a-zA-Z_]\w*(?=\s*\()/,
        {
          cases: {
            '@keywords': 'keyword',
            '@builtinFunctions': 'support.function',
            '@typeKeywords': 'type',
            '@constants': 'constant.language',
            '@default': 'entity.name.function'
          }
        }
      ],

      [/\b[A-Z][A-Z0-9_]{2,}\b/, 'constant'],

      [
        /\b[A-Z][a-zA-Z0-9_]*\b/,
        {
          cases: {
            '@constants': 'constant.language',
            '@typeKeywords': 'type',
            '@default': 'type.identifier'
          }
        }
      ],

      [
        /[a-zA-Z_]\w*/,
        {
          cases: {
            '@keywords': 'keyword',
            '@constants': 'constant.language',
            '@languageVars': 'variable.language',
            '@builtinFunctions': 'support.function',
            '@typeKeywords': 'type',
            '@default': 'identifier'
          }
        }
      ],

      [/0[xX][0-9a-fA-F_]+/, 'number'],
      [/0[oO][0-7_]+/, 'number'],
      [/0[bB][01_]+/, 'number'],
      [/(?:\d[\d_]*\.\d[\d_]*|\.\d[\d_]+)(?:[eE][+-]?\d[\d_]*)?[jJ]?/, 'number'],
      [/\d[\d_]*[eE][+-]?\d[\d_]*[jJ]?/, 'number'],
      [/\d[\d_]*[jJ]?/, 'number'],

      [/[{}()[\]]/, '@brackets'],
      [/->|:=|\*\*=?|\/\/=?|<<=?|>>=?|<=|>=|==|!=|[+\-*/%&|^~<>]=?/, 'operator'],
      [/[;,.?:=]/, 'delimiter']
    ],

    whitespace: [
      [/[ \t\r\n]+/, 'white'],
      [/#\s*(?:TODO|FIXME|NOTE|HACK|XXX).*$/, 'comment.todo'],
      [/#.*$/, 'comment']
    ],

    stringDouble: [
      [/[^\\"]+/, 'string'],
      [/@escapes/, 'string.escape'],
      [/\\./, 'string.escape'],
      [/"/, { token: 'string.quote', next: '@pop' }]
    ],
    stringSingle: [
      [/[^\\']+/, 'string'],
      [/@escapes/, 'string.escape'],
      [/\\./, 'string.escape'],
      [/'/, { token: 'string.quote', next: '@pop' }]
    ],
    stringTripleDouble: [
      [/"""/, { token: 'string.quote', next: '@pop' }],
      [/[^\\"]+/, 'string'],
      [/@escapes/, 'string.escape'],
      [/\\./, 'string.escape'],
      [/"/, 'string']
    ],
    stringTripleSingle: [
      [/'''/, { token: 'string.quote', next: '@pop' }],
      [/[^\\']+/, 'string'],
      [/@escapes/, 'string.escape'],
      [/\\./, 'string.escape'],
      [/'/, 'string']
    ],

    fstringDouble: [
      [/\{\{/, 'string.escape'],
      [/\}\}/, 'string.escape'],
      [/\{/, { token: 'keyword', next: '@fstringInterp' }],
      [/"/, { token: 'string.quote', next: '@pop' }],
      [/@escapes/, 'string.escape'],
      [/\\./, 'string.escape'],
      [/[^\\"{]+/, 'string']
    ],
    fstringSingle: [
      [/\{\{/, 'string.escape'],
      [/\}\}/, 'string.escape'],
      [/\{/, { token: 'keyword', next: '@fstringInterp' }],
      [/'/, { token: 'string.quote', next: '@pop' }],
      [/@escapes/, 'string.escape'],
      [/\\./, 'string.escape'],
      [/[^\\'{]+/, 'string']
    ],
    fstringTripleDouble: [
      [/"""/, { token: 'string.quote', next: '@pop' }],
      [/\{\{/, 'string.escape'],
      [/\}\}/, 'string.escape'],
      [/\{/, { token: 'keyword', next: '@fstringInterp' }],
      [/@escapes/, 'string.escape'],
      [/\\./, 'string.escape'],
      [/[^\\"{]+/, 'string'],
      [/"/, 'string']
    ],
    fstringTripleSingle: [
      [/'''/, { token: 'string.quote', next: '@pop' }],
      [/\{\{/, 'string.escape'],
      [/\}\}/, 'string.escape'],
      [/\{/, { token: 'keyword', next: '@fstringInterp' }],
      [/@escapes/, 'string.escape'],
      [/\\./, 'string.escape'],
      [/[^\\'{]+/, 'string'],
      [/'/, 'string']
    ],
    fstringInterp: [
      [/\}/, { token: 'keyword', next: '@pop' }],
      { include: 'root' }
    ]
  }
}
