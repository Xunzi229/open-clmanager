const { spawn } = require('node:child_process');
const { readdir } = require('node:fs/promises');
const { join } = require('node:path');

async function main() {
  const directory = join(__dirname, '..', 'dist', 'linux-unpacked');
  const files = await readdir(directory);
  const executable = ['clash-merge', 'Clash Merge', 'openclash'].find(name => files.includes(name));
  if (!executable) throw new Error(`找不到桌面程序：${files.join(', ')}`);
  const child = spawn(join(directory, executable), ['--no-sandbox'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let logs = ''; let exited = false;
  child.stderr.on('data', chunk => { logs += chunk.toString(); });
  child.on('exit', () => { exited = true; });
  try {
    let connected = false;
    for (let i = 0; i < 50; i++) {
      if (exited) throw new Error(`桌面程序提前退出：${logs.slice(-1500)}`);
      try {
        const response = await fetch('http://127.0.0.1:3838/api/config', { signal: AbortSignal.timeout(500) });
        const data = await response.json();
        if (response.ok && data.token && Array.isArray(data.sources)) { connected = true; break; }
      } catch { /* 等待窗口和服务启动。 */ }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!connected) throw new Error(`桌面程序未能启动本地服务：${logs.slice(-1500)}`);
    console.log('打包后的桌面程序已启动，HTTP 配置接口可访问');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 500));
    if (!exited) child.kill('SIGKILL');
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
