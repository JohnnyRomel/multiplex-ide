# MultiplexIDE

A macOS all-in-one multi-environment developer workspace that unifies **Sublime Text 3** aesthetics & speed, **cmux**-style multi-environment split terminals with automatic reconnect, **cross-environment global search & Goto Anything**, and **agentless SSH/SFTP drag-and-drop file transfer**.

## Features

- **Multi-Environment Workspaces (`Local` + SSH)**: Manage local and multiple remote SSH targets inside one window (`⌘ 1` .. `⌘ 9` instant switch, zero scrollback loss).
- **Agentless OpenSSH `ControlMaster` Multiplexing**: Reuses macOS OpenSSH (`~/.ssh/config`, `ProxyJump`, `ProxyCommand`, 2FA/SSO/certificates) — no remote daemon installation required.
- **cmux-Style Resilient Terminal**:
  - Recursive horizontal/vertical split panes (`⌘ \` / `⌘ ⇧ \`), `xterm.js` WebGL rendering, OSC 9/99/777 attention badges.
  - **Seamless Disconnect & Reconnect**: Preserves 100% of local xterm scrollback across disconnects, auto-reconnects with exponential backoff and macOS wake-from-sleep (`powerMonitor`), and automatically attaches per-pane hidden-statusbar `tmux` sessions on remote hosts when available.
- **Sublime Text 3-Inspired Editor**:
  - Authentic **Monokai**, **Mariana**, and **Boxy Dark** themes, raised seamless tabs, dirty `●` indicator, Minimap, 1/2-column split (`⌥ ⌘ 1` / `⌥ ⌘ 2`), cross-environment file Diff, and classic ST3 shortcuts.
  - Enhanced non-LSP syntax highlighting for **C/C++/CUDA** and **Python** (functions, namespaces, STL/typing types, `self`/`this`, `@decorators`, `#include`, f-strings, magic dunders, `TODO` tags).
- **Fast Multi-Environment Search (`⌘ ⇧ F`) & Goto Files (`⌘ P`)**:
  - Server-side `rg --files -L` (follows symlinks, handles huge monorepos without truncation) + `file:line` jump.
  - Streaming multi-environment `rg --json` (with `grep -rnI` fallback) and editable `Where:` path bar.
- **Cross-Environment File Tree & Drag-and-Drop Transfer**:
  - Drop from Finder onto any folder or workspace to upload.
  - **Dual Tree / Transfer Mode** to drag files/folders directly between `Local ↔ SSH` or `SSH-A ↔ SSH-B` over streaming SFTP pipes.
  - Hold **`⌥ (Option) + Drag`** on remote files to drag directly to Finder, or right-click `Download to Mac...`.

## Local Workspace Configuration (Not Committed to Git)

MultiplexIDE never stores personal hosts in the repository. On startup, it loads configuration from the first local path found:

1. `MULTIPLEX_CONFIG_PATH` environment variable (if set)
2. `./multiplex.local.json` in the project directory (**gitignored** — ideal for local development)
3. `~/.config/multiplex-ide/config.json` (auto-created on first launch with `Local` only)

To configure your own SSH environments locally:

```bash
cp multiplex.config.example.json multiplex.local.json
```

Or press **`⌘ ,`** inside the app to edit your active config JSON directly in an editor tab — pressing **`⌘ S`** hot-reloads workspaces and theme immediately.

See [multiplex.config.example.json](multiplex.config.example.json) for all supported fields (`theme`, `showAllSshConfigHosts`, `extraPathDirs`, and `workspaces`).

## Development & Packaging (macOS)

```bash
# Install dependencies (rebuilds node-pty for Electron)
npm install

# Run in development mode
npm run dev

# Typecheck + unit tests + production build
npm run typecheck && npm test && npm run build

# Package macOS .app / .dmg into dist/
npm run package:mac
```

## Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `⌘ ,` | Open active config JSON in editor (`⌘ S` hot-reloads) |
| `⌘ 1` .. `⌘ 9` | Switch workspace |
| `⌘ P` | Goto Anything (supports `path:line` & multi-workspace toggle) |
| `⌘ ⇧ F` | Find in Files across one or multiple environments |
| `⌘ \` / `⌘ ⇧ \` | Split active terminal horizontally / vertically |
| `⌥ ⌘ 1` / `⌥ ⌘ 2` | Single / 2-column editor layout |
| `⌘ B` / `⌘ J` | Toggle sidebar / terminal panel |
| `⌘ S` / `⌘ W` | Save current file / close current tab |
| `⌘ D` / `⌘ ⇧ D` / `⌘ L` / `⌘ ⇧ K` | Select next occurrence / duplicate line / select line / delete line |

## License

[MIT](LICENSE)
