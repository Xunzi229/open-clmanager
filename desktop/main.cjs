const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DEFAULT_PORT, validatePort, readPort, savePort } = require('./port.cjs');

let port = DEFAULT_PORT;
const base = () => `http://127.0.0.1:${port}`;
const standbyPath = path.join(__dirname, 'standby.html');
const standbyURL = pathToFileURL(standbyPath).href;
let window, service, server, operation = Promise.resolve(), quitting = false;

function serialize(task) {
  const result = operation.then(task);
  operation = result.catch(() => {});
  return result;
}
function assertSender(event) {
  if (!window || event.sender !== window.webContents || ![base() + '/', standbyURL].includes(event.sender.getURL())) {
    throw new Error('此窗口无权控制本地服务');
  }
}
function safeMessage(error) {
  if (error?.code === 'EADDRINUSE') return `${port} 端口已被占用。请换一个端口，或关闭占用该端口的程序。`;
  if (error?.code === 'EACCES') return `没有权限监听 ${port} 端口。`;
  return '服务启动失败，请检查应用数据目录是否可写。';
}
async function showStandby(message = '') {
  if (!window || window.isDestroyed()) return;
  await window.loadFile(standbyPath);
  window.webContents.send('service-status', { running: false, message, port });
}
async function startService() {
  return serialize(async () => {
    if (server?.listening) return { running: true, url: base(), port };
    let candidate, listener;
    try {
      const [{ SubscriptionService }, { createApp }] = await Promise.all([
        import('../src/service.js'), import('../src/server.js'),
      ]);
      candidate = await new SubscriptionService(path.join(app.getPath('userData'), 'data')).init();
      listener = createApp(candidate);
      await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(port, '127.0.0.1', () => { listener.off('error', reject); resolve(); });
      });
      service = candidate; server = listener;
      service.startScheduler();
      await window.loadURL(base());
      return { running: true, url: base(), port };
    } catch (error) {
      candidate?.close();
      if (listener?.listening) listener.close();
      server = undefined; service = undefined;
      const message = safeMessage(error);
      await showStandby(message);
      return { running: false, message, port };
    }
  });
}
async function stopService() {
  return serialize(async () => {
    if (!server) { if (!quitting) await showStandby(); return { running: false }; }
    service.close();
    const closing = server;
    server = undefined; service = undefined;
    closing.closeAllConnections();
    await new Promise(resolve => closing.close(resolve));
    if (!quitting) await showStandby();
    return { running: false };
  });
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.clashmerge.desktop');
  try { port = await readPort(app.getPath('userData')); }
  catch { port = DEFAULT_PORT; }
  window = new BrowserWindow({
    width: 1180, height: 820, minWidth: 740, minHeight: 600,
    title: 'Clash Merge', backgroundColor: '#f5f7f4', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (![base() + '/', standbyURL].includes(url)) event.preventDefault();
  });
  ipcMain.handle('service:status', event => { assertSender(event); return { running: !!server?.listening, url: base(), port }; });
  ipcMain.handle('service:start', event => { assertSender(event); return startService(); });
  ipcMain.handle('service:stop', event => { assertSender(event); return stopService(); });
  ipcMain.handle('service:set-port', async (event, value) => {
    assertSender(event);
    const next = validatePort(value);
    if (next === port) return { running: !!server?.listening, port };
    const wasRunning = !!server?.listening;
    if (wasRunning) await stopService();
    port = await savePort(app.getPath('userData'), next);
    return wasRunning ? startService() : { running: false, port };
  });
  ipcMain.handle('service:open-browser', async event => { assertSender(event); if (server?.listening) await shell.openExternal(base()); });
  window.on('closed', () => { window = undefined; });
  await showStandby();
  await startService();
});
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true;
  stopService().finally(() => app.quit());
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) app.quit(); });
