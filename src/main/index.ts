import { app, BrowserWindow, Menu, nativeImage, powerMonitor, session, shell, webContents } from 'electron'
import fs from 'fs'
import path from 'path'
import { IPC } from '@shared/ipc'
import { EnvironmentRegistry } from './ssh/configParser'
import { SshControlMaster, setConfiguredExtraPathDirs } from './ssh/controlMaster'
import { TerminalManager } from './terminal/terminalManager'
import { UnifiedVfs } from './fs/vfs'
import { TransferManager } from './fs/transferManager'
import { SearchManager } from './search/searchManager'
import { registerIpcHandlers } from './ipc/registerHandlers'

// Set application name BEFORE app.whenReady() so macOS Menu Bar & Dock display "MultiplexIDE" immediately
app.setName('MultiplexIDE')

let mainWindow: BrowserWindow | null = null
let registry: EnvironmentRegistry
let controlMaster: SshControlMaster
let terminalManager: TerminalManager
let vfs: UnifiedVfs
let transferManager: TransferManager
let searchManager: SearchManager

function sendToRenderer(channel: string, ...args: any[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

function resolveAppIconPath(): string | undefined {
  const candidates = [
    path.join(app.getAppPath(), 'resources', 'icon.png'),
    path.join(process.resourcesPath || '', 'icon.png'),
    path.resolve(__dirname, '../../resources/icon.png')
  ]
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p
  }
  return undefined
}

function createWindow(): void {
  const iconPath = resolveAppIconPath()
  const windowIcon = iconPath ? nativeImage.createFromPath(iconPath) : undefined

  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 620,
    title: 'MultiplexIDE',
    icon: windowIcon && !windowIcon.isEmpty() ? windowIcon : undefined,
    backgroundColor: '#272822', // Classic Sublime Text 3 Monokai canvas
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function dispatchEditAction(action: 'cut' | 'copy' | 'paste' | 'selectAll'): void {
  const focused = webContents.getFocusedWebContents()
  if (!focused || focused.isDestroyed()) return
  if (mainWindow && !mainWindow.isDestroyed() && focused.id === mainWindow.webContents.id) {
    focused.send(IPC.CLIPBOARD_ACTION, action)
    return
  }
  // DevTools or secondary windows use native Chromium edit commands directly
  if (action === 'copy') focused.copy()
  else if (action === 'cut') focused.cut()
  else if (action === 'paste') focused.paste()
  else if (action === 'selectAll') focused.selectAll()
}

function buildMacMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'MultiplexIDE',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { label: 'Cut', accelerator: 'CmdOrCtrl+X', click: () => dispatchEditAction('cut') },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => dispatchEditAction('copy') },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: () => dispatchEditAction('paste') },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => dispatchEditAction('selectAll') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(() => {
  const iconPath = resolveAppIconPath()

  app.setAboutPanelOptions({
    applicationName: 'MultiplexIDE',
    applicationVersion: app.getVersion(),
    copyright: 'Copyright © 2026 MultiplexIDE Contributors · MIT License',
    iconPath
  })

  // Apply custom macOS Dock icon immediately (visible in both dev mode and packaged builds)
  if (process.platform === 'darwin' && app.dock && iconPath) {
    const dockIcon = nativeImage.createFromPath(iconPath)
    if (!dockIcon.isEmpty()) {
      app.dock.setIcon(dockIcon)
    }
  }

  // Always allow clipboard read/write so Monaco & web widgets stay synced with macOS pasteboard
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    if (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write') return true
    return true
  })
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write') {
      callback(true)
      return
    }
    callback(false)
  })

  buildMacMenu()

  registry = new EnvironmentRegistry(app.getPath('userData'))
  setConfiguredExtraPathDirs(registry.getExtraPathDirs())
  controlMaster = new SshControlMaster()
  vfs = new UnifiedVfs(controlMaster)

  const markConnected = (envId: string) => {
    const env = registry.setStatus(envId, 'connected', undefined)
    if (env) sendToRenderer(IPC.ENV_STATUS_CHANGED, env)
  }

  terminalManager = new TerminalManager(controlMaster, {
    onData: (terminalId, data) => sendToRenderer(IPC.TERM_DATA, terminalId, data),
    onExit: (terminalId, envId, exitCode) => sendToRenderer(IPC.TERM_EXIT, terminalId, envId, exitCode),
    onStatus: (status) => sendToRenderer(IPC.TERM_STATUS, status),
    onNotification: (notification) => sendToRenderer(IPC.TERM_NOTIFICATION, notification),
    onSshConnected: markConnected,
    onSshDisconnected: (envId) => {
      vfs.disposeEnv(envId)
      const env = registry.setStatus(envId, 'disconnected', 'SSH connection lost — auto-reconnecting')
      if (env) sendToRenderer(IPC.ENV_STATUS_CHANGED, env)
    }
  })

  // Automatically recover SSH terminals after macOS wakes from sleep (cmux-style resilience!)
  powerMonitor.on('resume', () => {
    void terminalManager.handleSystemResume()
  })

  transferManager = new TransferManager(vfs, (task) => {
    sendToRenderer(IPC.TRANSFER_UPDATE, task)
  })

  searchManager = new SearchManager(controlMaster, {
    onMatchBatch: (matches) => sendToRenderer(IPC.SEARCH_MATCH_BATCH, matches),
    onDone: (done) => sendToRenderer(IPC.SEARCH_DONE, done),
    onSshConnected: markConnected
  })

  registerIpcHandlers({
    registry,
    controlMaster,
    terminalManager,
    vfs,
    transferManager,
    searchManager,
    getMainWindow: () => mainWindow
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  terminalManager?.killAll()
  vfs?.disposeAll()
})
