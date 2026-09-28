const button = document.querySelector('#start');
const error = document.querySelector('#error');
const port = document.querySelector('#port');
window.desktop.onStatus(status => { error.textContent = status.message || ''; if (status.port) port.value = status.port; });
window.desktop.status().then(status => { port.value = status.port; }).catch(() => {});
button.addEventListener('click', async () => {
  button.disabled = true;
  button.textContent = '正在启动…';
  try {
    const settings = await window.desktop.setPort(port.value);
    if (settings.port) port.value = settings.port;
    const result = await window.desktop.start(); error.textContent = result.message || '';
  } catch (cause) { error.textContent = cause.message?.includes('1024') ? '端口必须是 1024～65535 的整数。' : '启动失败，请重试。'; }
  finally { button.disabled = false; button.textContent = '启动服务 →'; }
});
