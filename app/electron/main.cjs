// Desktop shell. The UI is a local React bundle; all data comes from the Shadow Agent server
// (Docker or `npm run server`) over HTTP and WebSocket.
const { app, BrowserWindow, ipcMain, shell, nativeTheme } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEV = !!process.env.SHADOW_DEV;
const HOME = process.env.SHADOW_HOME || path.join(os.homedir(), '.shadowagent');

/** The server writes its admin token into the shared data folder; the app picks it up from there. */
function connection() {
  const url = (process.env.SHADOW_URL || 'http://127.0.0.1:7777').replace(/\/+$/, '');
  let token = process.env.SHADOW_TOKEN || '';
  if (!token) {
    try { token = fs.readFileSync(path.join(HOME, 'admin.token'), 'utf8').trim(); } catch { /* server has not run yet */ }
  }
  return { url, token, home: HOME };
}

function createWindow() {
  nativeTheme.themeSource = 'dark';
  const win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 1040, minHeight: 680,
    backgroundColor: '#090a11',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 20 },
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => win.show());
  // Links open in the real browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('http://localhost:5273') && !url.startsWith('file:')) e.preventDefault(); });
  if (DEV) win.loadURL('http://localhost:5273');
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

ipcMain.handle('shadow:connection', () => connection());

app.setName('Shadow Agents');
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
