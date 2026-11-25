import React from 'react'
import {
  Braces,
  Container,
  Database,
  File,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  GitBranch,
  Globe,
  Hammer,
  Lock,
  Scale,
  Settings2,
  Share2,
  TerminalSquare
} from 'lucide-react'

interface BadgeProps {
  label: string
  bg: string
  fg?: string
  size?: number
}

const MicroBadge: React.FC<BadgeProps> = ({ label, bg, fg = '#151612', size = 16 }) => (
  <span
    className="inline-flex shrink-0 items-center justify-center rounded-[3px] font-mono font-extrabold leading-none select-none"
    style={{
      width: `${size}px`,
      height: `${size}px`,
      backgroundColor: bg,
      color: fg,
      fontSize: label.length >= 3 ? '7.5px' : label.length === 2 ? '8.5px' : '9.5px',
      letterSpacing: '-0.03em'
    }}
  >
    {label}
  </span>
)

const ReactAtomSvg: React.FC<{ color: string; size: number }> = ({ color, size }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    className="shrink-0"
    stroke={color}
    strokeWidth="1.8"
  >
    <circle cx="12" cy="12" r="2.2" fill={color} stroke="none" />
    <ellipse cx="12" cy="12" rx="9.5" ry="3.8" />
    <ellipse cx="12" cy="12" rx="9.5" ry="3.8" transform="rotate(60 12 12)" />
    <ellipse cx="12" cy="12" rx="9.5" ry="3.8" transform="rotate(120 12 12)" />
  </svg>
)

const PythonSvg: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="shrink-0">
    <path
      d="M11.9 2C7.8 2 8.1 3.8 8.1 3.8V5.9H12.1V6.6H6.5C6.5 6.6 3.8 6.3 3.8 10.5C3.8 14.7 6.1 14.5 6.1 14.5H7.5V12.5C7.5 12.5 7.4 10.2 9.8 10.2H13.8C13.8 10.2 16 10.2 16 8.1V4.3C16 4.3 16.3 2 11.9 2ZM9.7 3.4C10.2 3.4 10.6 3.8 10.6 4.3C10.6 4.8 10.2 5.2 9.7 5.2C9.2 5.2 8.8 4.8 8.8 4.3C8.8 3.8 9.2 3.4 9.7 3.4Z"
      fill="#5A9FD4"
    />
    <path
      d="M12.1 22C16.2 22 15.9 20.2 15.9 20.2V18.1H11.9V17.4H17.5C17.5 17.4 20.2 17.7 20.2 13.5C20.2 9.3 17.9 9.5 17.9 9.5H16.5V11.5C16.5 11.5 16.6 13.8 14.2 13.8H10.2C10.2 13.8 8 13.8 8 15.9V19.7C8 19.7 7.7 22 12.1 22ZM14.3 20.6C13.8 20.6 13.4 20.2 13.4 19.7C13.4 19.2 13.8 18.8 14.3 18.8C14.8 18.8 15.2 19.2 15.2 19.7C15.2 20.2 14.8 20.6 14.3 20.6Z"
      fill="#FFD43B"
    />
  </svg>
)

const MarkdownSvg: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="shrink-0">
    <rect x="2" y="4.5" width="20" height="15" rx="2.5" stroke="#66D9EF" strokeWidth="1.8" />
    <path d="M5.5 15.5V8.5L8.5 12L11.5 8.5V15.5" stroke="#66D9EF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M16.5 8.5V15M16.5 15L14.2 12.6M16.5 15L18.8 12.6" stroke="#66D9EF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export interface FileIconProps {
  name: string
  size?: number
}

/**
 * Crisp developer IDE file icon resolver covering C/C++/CUDA, Python, TS/JS/React, Go, Rust,
 * Shell, JSON/YAML/TOML, Markdown, Docker, Git, CMake/Bazel/Makefile, Protobuf, SQL, Images, and Locks.
 */
export const FileIcon: React.FC<FileIconProps> = ({ name, size = 15 }) => {
  const lower = name.toLowerCase()
  const iconStyle = { width: `${size}px`, height: `${size}px` }

  // Special exact filenames
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.') || lower.startsWith('docker-compose')) {
    return <Container className="shrink-0" style={{ ...iconStyle, color: '#38BDF8' }} />
  }
  if (
    lower === '.gitignore' ||
    lower === '.gitmodules' ||
    lower === '.gitattributes' ||
    lower === '.gitkeep'
  ) {
    return <GitBranch className="shrink-0" style={{ ...iconStyle, color: '#F92672' }} />
  }
  if (
    lower === 'makefile' ||
    lower === 'gnumakefile' ||
    lower === 'cmakelists.txt' ||
    lower === 'build' ||
    lower === 'build.bazel' ||
    lower === 'workspace' ||
    lower === 'workspace.bazel' ||
    lower === 'justfile'
  ) {
    return <Hammer className="shrink-0" style={{ ...iconStyle, color: '#FD971F' }} />
  }
  if (lower === 'license' || lower.startsWith('license.') || lower === 'copying') {
    return <Scale className="shrink-0" style={{ ...iconStyle, color: '#E6DB74' }} />
  }
  if (
    lower === 'package-lock.json' ||
    lower === 'yarn.lock' ||
    lower === 'pnpm-lock.yaml' ||
    lower === 'cargo.lock' ||
    lower === 'poetry.lock' ||
    lower === 'uv.lock' ||
    lower === 'go.sum'
  ) {
    return <Lock className="shrink-0" style={{ ...iconStyle, color: '#8F908A' }} />
  }
  if (
    lower === '.zshrc' ||
    lower === '.bashrc' ||
    lower === '.bash_profile' ||
    lower === '.zprofile' ||
    lower === '.profile'
  ) {
    return <TerminalSquare className="shrink-0" style={{ ...iconStyle, color: '#A6E22E' }} />
  }
  if (lower.startsWith('.env')) {
    return <Settings2 className="shrink-0" style={{ ...iconStyle, color: '#E6DB74' }} />
  }

  const ext = lower.includes('.') ? lower.split('.').pop() ?? '' : ''

  switch (ext) {
    // TypeScript / JavaScript / React
    case 'tsx':
      return <ReactAtomSvg color="#61DAFB" size={size} />
    case 'jsx':
      return <ReactAtomSvg color="#F7DF1E" size={size} />
    case 'ts':
    case 'mts':
    case 'cts':
      return <MicroBadge label="TS" bg="#3178C6" fg="#FFFFFF" size={size} />
    case 'js':
    case 'mjs':
    case 'cjs':
      return <MicroBadge label="JS" bg="#F0DB4F" fg="#181915" size={size} />

    // Python & Notebooks
    case 'py':
    case 'pyi':
    case 'pyx':
    case 'pxd':
    case 'bzl':
      return <PythonSvg size={size} />
    case 'ipynb':
      return <MicroBadge label="NB" bg="#FD971F" fg="#181915" size={size} />

    // C / C++ / Header / CUDA
    case 'cpp':
    case 'cc':
    case 'cxx':
    case 'ipp':
    case 'tpp':
      return <MicroBadge label="C+" bg="#519ABA" fg="#FFFFFF" size={size} />
    case 'c':
      return <MicroBadge label="C" bg="#519ABA" fg="#FFFFFF" size={size} />
    case 'h':
    case 'hh':
    case 'hpp':
    case 'hxx':
    case 'inl':
      return <MicroBadge label="H" bg="#A074C4" fg="#FFFFFF" size={size} />
    case 'cu':
    case 'cuh':
      return <MicroBadge label="CU" bg="#76B900" fg="#141511" size={size} />

    // Go / Rust / JVM / Swift / Scripting
    case 'go':
    case 'mod':
      return <MicroBadge label="GO" bg="#00ADD8" fg="#0F171A" size={size} />
    case 'rs':
      return <MicroBadge label="RS" bg="#DEA584" fg="#181915" size={size} />
    case 'java':
    case 'jar':
      return <MicroBadge label="JV" bg="#E76F00" fg="#FFFFFF" size={size} />
    case 'kt':
    case 'kts':
      return <MicroBadge label="KT" bg="#7F52FF" fg="#FFFFFF" size={size} />
    case 'swift':
      return <MicroBadge label="SW" bg="#F05138" fg="#FFFFFF" size={size} />
    case 'rb':
      return <MicroBadge label="RB" bg="#CC342D" fg="#FFFFFF" size={size} />
    case 'lua':
      return <MicroBadge label="LU" bg="#51A0CF" fg="#FFFFFF" size={size} />
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'fish':
      return <TerminalSquare className="shrink-0" style={{ ...iconStyle, color: '#A6E22E' }} />

    // Config, Schema & Data
    case 'json':
    case 'jsonc':
    case 'jsonl':
      return <Braces className="shrink-0" style={{ ...iconStyle, color: '#E6DB74' }} />
    case 'yaml':
    case 'yml':
    case 'toml':
    case 'ini':
    case 'conf':
    case 'cfg':
    case 'properties':
      return <Settings2 className="shrink-0" style={{ ...iconStyle, color: '#AE81FF' }} />
    case 'cmake':
    case 'mk':
      return <Hammer className="shrink-0" style={{ ...iconStyle, color: '#FD971F' }} />
    case 'proto':
    case 'graphql':
    case 'gql':
    case 'thrift':
      return <Share2 className="shrink-0" style={{ ...iconStyle, color: '#F92672' }} />
    case 'sql':
    case 'sqlite':
    case 'db':
    case 'parquet':
      return <Database className="shrink-0" style={{ ...iconStyle, color: '#66D9EF' }} />
    case 'csv':
    case 'tsv':
      return <FileSpreadsheet className="shrink-0" style={{ ...iconStyle, color: '#A6E22E' }} />

    // Web, Styles & Docs
    case 'md':
    case 'mdx':
    case 'rst':
      return <MarkdownSvg size={size} />
    case 'txt':
    case 'log':
      return <FileText className="shrink-0" style={{ ...iconStyle, color: '#A6A69C' }} />
    case 'html':
    case 'htm':
      return <Globe className="shrink-0" style={{ ...iconStyle, color: '#F97B58' }} />
    case 'css':
    case 'scss':
    case 'less':
      return <MicroBadge label="#" bg="#56B6C2" fg="#141511" size={size} />
    case 'xml':
    case 'plist':
      return <Braces className="shrink-0" style={{ ...iconStyle, color: '#FD971F' }} />

    // Images & Archives
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'svg':
    case 'ico':
    case 'icns':
      return <FileImage className="shrink-0" style={{ ...iconStyle, color: '#AE81FF' }} />
    case 'zip':
    case 'tar':
    case 'gz':
    case 'tgz':
    case 'bz2':
    case 'xz':
    case 'zst':
    case 'dmg':
      return <FileArchive className="shrink-0" style={{ ...iconStyle, color: '#FD971F' }} />
    case 'lock':
      return <Lock className="shrink-0" style={{ ...iconStyle, color: '#8F908A' }} />

    default:
      return <File className="shrink-0" style={{ ...iconStyle, color: 'var(--st-text-dim)' }} />
  }
}

export interface FolderIconProps {
  name: string
  isOpen: boolean
  size?: number
}

function getFolderColor(name: string): string {
  const lower = name.toLowerCase()
  if (['src', 'lib', 'app', 'pkg', 'include', 'core', 'shared', 'main', 'renderer', 'preload', 'components'].includes(lower)) {
    return '#66D9EF'
  }
  if (['test', 'tests', '__tests__', 'spec', 'specs', 'benchmarks'].includes(lower)) {
    return '#A6E22E'
  }
  if (['scripts', 'bin', 'tools', 'cmd', 'hack'].includes(lower)) {
    return '#FD971F'
  }
  if (['config', 'configs', '.config', '.github', '.vscode', 'resources', 'assets', 'public'].includes(lower)) {
    return '#AE81FF'
  }
  if (['docs', 'doc', 'examples'].includes(lower)) {
    return '#E6DB74'
  }
  if (['.git', 'node_modules', 'dist', 'out', 'build', 'target', '__pycache__', '.venv', 'venv'].includes(lower)) {
    return '#75715E'
  }
  return '#B4B5AA'
}

export const FolderIcon: React.FC<FolderIconProps> = ({ name, isOpen, size = 16 }) => {
  const color = getFolderColor(name)
  if (isOpen) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="shrink-0">
        <path
          d="M3 6.5C3 5.4 3.9 4.5 5 4.5H9.2L11.2 6.8H19C20.1 6.8 21 7.7 21 8.8V10H3V6.5Z"
          fill={color}
          fillOpacity="0.85"
        />
        <path
          d="M2.4 10H21.6L19.8 18.5C19.6 19.4 18.8 20 17.9 20H6.1C5.2 20 4.4 19.4 4.2 18.5L2.4 10Z"
          fill={color}
          fillOpacity="0.32"
          stroke={color}
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    )
  }

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="shrink-0">
      <path
        d="M3 6.5C3 5.4 3.9 4.5 5 4.5H9.3L11.4 6.8H19C20.1 6.8 21 7.7 21 8.8V17.8C21 18.9 20.1 19.8 19 19.8H5C3.9 19.8 3 18.9 3 17.8V6.5Z"
        fill={color}
        fillOpacity="0.22"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  )
}
