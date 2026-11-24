# MultiplexIDE

macOS 一体化多环境开发工具：**Sublime Text 3** 极简视觉与主题（Monokai / Mariana / Boxy Dark）+ **cmux** 多环境分屏终端 + **多环境全局搜索 & Goto Files** + **无侵入 SSH/SFTP 双向拖拽文件传输**。

## 配置文件说明 (`~/.config/multiplex-ide/config.json`)

首次启动自动生成配置文件，默认仅展示 **本机 (`Local Mac`)**、**`dev92` (`~/workspace`)**、**`cn_a10` (`~`)** 三个工作区（不会将 `~/.ssh/config` 中所有主机全部铺满侧边栏，但仍会自动从 `~/.ssh/config` 读取对应主机的 `HostName`、`User`、`Port`、`ProxyJump` 配置）。

在应用内按 **`⌘ ,`**（或点击侧边栏 / 右上角齿轮图标）即可直接在编辑器内打开 `config.json`，修改后按 **`⌘ S`** 保存即可实时热更新工作区列表与主题！

```json
{
  "theme": "monokai",
  "showAllSshConfigHosts": false,
  "workspaces": [
    {
      "id": "local",
      "name": "Local Mac",
      "kind": "local",
      "defaultPath": "~/Documents/code",
      "color": "#66d9ef",
      "pinned": true
    },
    {
      "id": "ssh:dev92",
      "name": "dev92",
      "kind": "ssh",
      "host": "dev92",
      "defaultPath": "~/workspace",
      "color": "#a6e22e",
      "useTmux": false,
      "pinned": true
    },
    {
      "id": "ssh:cn_a10",
      "name": "cn_a10",
      "kind": "ssh",
      "host": "cn_a10",
      "defaultPath": "~",
      "color": "#fd971f",
      "useTmux": false,
      "pinned": true
    }
  ]
}
```

## 启动与验证

```bash
# 开发模式启动
npm run dev

# 类型检查 + 单元测试 + 生产构建
npm run typecheck && npm test && npm run build

# 打包 macOS .app / .dmg
npm run package:mac
```

## 常用快捷键

| 快捷键 | 功能 |
| :--- | :--- |
| `⌘ ,` | 在编辑器中打开 `config.json` 配置文件（`⌘ S` 保存即热加载） |
| `⌘ 1` / `⌘ 2` / `⌘ 3` | 秒切工作区（Local Mac / dev92 / cn_a10） |
| `⌘ P` | Sublime Goto Anything（模糊跳文件，支持 `path:line` 行号跳转与跨环境切换） |
| `⌘ ⇧ F` | Sublime Find in Files（支持可编辑 `Where` 路径与多环境并发检索） |
| `⌘ \` / `⌘ ⇧ \` | 终端水平 / 垂直分屏 |
| `⌥ ⌘ 1` / `⌥ ⌘ 2` | 编辑器单列 / 双列布局 |
| `⌘ B` / `⌘ J` | 展开/收起左侧边栏 / 底部终端面板 |
| `⌘ S` / `⌘ W` | 保存当前文件 / 关闭当前标签 |
