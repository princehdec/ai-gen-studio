const { app, BrowserWindow, dialog, shell, ipcMain, Menu } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const fs = require('node:fs');

let backendProcess;
let ollamaProcess;
let backendPort;
let backendRestarting = false;
let mainWindow;
let updateState = { status: 'idle', message: 'Updates are not checked yet.', version: null, progress: 0 };

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function projectRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked')
    : path.join(__dirname, '..');
}

function isDevBuild() {
  return app.getName().toLowerCase().includes('dev');
}

async function ensureOllama() {
  if (!isDevBuild()) return;
  try {
    const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1200) });
    if (response.ok) return;
  } catch { /* Ollama is not running yet. */ }
  const candidates = [
    'ollama.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe') : '',
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Ollama', 'ollama.exe') : '',
  ].filter(Boolean);
  const executable = candidates.find((candidate) => candidate === 'ollama.exe' || fs.existsSync(candidate));
  if (!executable) return;
  try {
    ollamaProcess = spawn(executable, ['serve'], { windowsHide: true, stdio: 'ignore' });
    ollamaProcess.on('error', () => { ollamaProcess = null; });
    ollamaProcess.unref();
    const started = Date.now();
    while (Date.now() - started < 12000) {
      try {
        const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1000) });
        if (response.ok) return;
      } catch { /* Ollama is still starting. */ }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  } catch { /* Chat will show the actionable offline message if Ollama is unavailable. */ }
}

function startBackend(port) {
  const root = projectRoot();
  const backendRoot = path.join(root, 'backend');
  const entry = path.join(backendRoot, 'src', 'server.js');
  const userStorage = path.join(app.getPath('userData'), 'storage');
  const env = {
    ...process.env,
    PORT: String(port),
    STORAGE_DIR: path.join(userStorage, 'files'),
    DB_PATH: path.join(userStorage, 'app.db'),
    PROVIDER_CONFIG_PATH: path.join(userStorage, 'providers.json'),
    // Allows the packaged Electron binary to execute the Node backend script.
    ELECTRON_RUN_AS_NODE: '1',
  };
  backendProcess = spawn(process.execPath, [entry], {
    cwd: backendRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  backendProcess.stdout.on('data', (data) => console.log(`[backend] ${data}`));
  backendProcess.stderr.on('data', (data) => console.error(`[backend] ${data}`));
  backendProcess.on('exit', () => {
    if (app.isQuitting || backendRestarting) return;
    backendRestarting = true;
    setTimeout(async () => {
      try {
        startBackend(backendPort);
        await waitForBackend(backendPort, 15000);
        mainWindow?.webContents.send('backend-reconnected');
      } catch (err) {
        dialog.showErrorBox('AI Gen Studio server error', `The local backend could not be restarted. ${err.message}`);
      } finally {
        backendRestarting = false;
      }
    }, 500);
  });
}

async function waitForBackend(port, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (response.ok) return;
    } catch { /* backend is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('The local backend did not become ready in time.');
}

function setUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  mainWindow?.webContents.send('updates:state', updateState);
}

function readRepository() {
  try {
    const pkg = require(path.join(app.getAppPath(), 'package.json'));
    const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    const match = String(repo || '').match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?/i);
    return match ? { owner: match[1], repo: match[2] } : null;
  } catch {
    return null;
  }
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  if (!app.isPackaged) {
    setUpdateState({ status: 'dev', message: 'Updates are available after installing a packaged desktop build.' });
    return;
  }
  if (!readRepository()) {
    setUpdateState({ status: 'unconfigured', message: 'Add a public GitHub repository to package.json to enable updates.' });
    return;
  }
  autoUpdater.on('checking-for-update', () => setUpdateState({ status: 'checking', message: 'Checking for updates…' }));
  autoUpdater.on('update-available', (info) => setUpdateState({ status: 'available', message: `Version ${info.version} is available.`, version: info.version, progress: 0 }));
  autoUpdater.on('update-not-available', (info) => setUpdateState({ status: 'current', message: `You are up to date (${info.version || app.getVersion()}).`, version: info.version || app.getVersion(), progress: 0 }));
  autoUpdater.on('download-progress', (progress) => setUpdateState({ status: 'downloading', message: `Downloading update… ${Math.round(progress.percent)}%`, progress: progress.percent }));
  autoUpdater.on('update-downloaded', (info) => setUpdateState({ status: 'downloaded', message: `Version ${info.version} is ready to install.`, version: info.version, progress: 100 }));
  autoUpdater.on('error', (err) => setUpdateState({ status: 'error', message: `Update check failed: ${err.message}` }));
}

ipcMain.handle('app:info', () => ({
  name: 'AI Gen Studio',
  version: app.getVersion(),
  packaged: app.isPackaged,
  platform: process.platform,
  arch: process.arch,
}));

ipcMain.handle('updates:status', () => updateState);
ipcMain.handle('updates:check', async () => {
  if (!app.isPackaged) return setUpdateState({ status: 'dev', message: 'Updates are available after installing a packaged desktop build.' });
  if (!readRepository()) return setUpdateState({ status: 'unconfigured', message: 'Add a public GitHub repository to package.json to enable updates.' });
  try { await autoUpdater.checkForUpdates(); } catch (err) { setUpdateState({ status: 'error', message: `Update check failed: ${err.message}` }); }
  return updateState;
});
ipcMain.handle('updates:download', async () => {
  if (updateState.status !== 'available') return updateState;
  try { await autoUpdater.downloadUpdate(); } catch (err) { setUpdateState({ status: 'error', message: `Update download failed: ${err.message}` }); }
  return updateState;
});
ipcMain.handle('updates:install', () => {
  if (updateState.status === 'downloaded') autoUpdater.quitAndInstall();
  return updateState;
});

function sendMenuAction(action) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('menu-action', action);
}

function buildApplicationMenu() {
  const template = [
    { label: 'File', submenu: [{ role: 'quit', label: 'Exit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] },
    {
      label: 'Help',
      submenu: [
        { label: 'Help & Updates', click: () => sendMenuAction('help') },
        { label: 'About AI Gen Studio', click: () => sendMenuAction('about') },
        { label: 'Provider Settings', click: () => sendMenuAction('settings') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  setupAutoUpdater();
  await ensureOllama();
  backendPort = await findFreePort();
  startBackend(backendPort);
  await waitForBackend(backendPort);
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 680,
    backgroundColor: '#fbfbfd',
    title: 'AI Gen Studio',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  await mainWindow.loadURL(`http://127.0.0.1:${backendPort}`);
  if (app.isPackaged && readRepository()) {
    setTimeout(() => autoUpdater.checkForUpdates().catch((err) => {
      setUpdateState({ status: 'error', message: `Update check failed: ${err.message}` });
    }), 1500);
  }
}

app.whenReady().then(() => {
  buildApplicationMenu();
  return createWindow();
}).catch((err) => {
  dialog.showErrorBox('Could not start AI Gen Studio', err.message);
  app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (backendProcess && !backendProcess.killed) backendProcess.kill();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
