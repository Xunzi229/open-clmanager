const { readFile, writeFile, rename, unlink, mkdir } = require('node:fs/promises');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT_PORT = 3838;
function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口必须是 1024～65535 的整数');
  return port;
}
async function readPort(directory) {
  try {
    const settings = JSON.parse(await readFile(join(directory, 'desktop-settings.json'), 'utf8'));
    return validatePort(settings.port);
  } catch (error) {
    if (error.code === 'ENOENT') return DEFAULT_PORT;
    throw error;
  }
}
async function savePort(directory, value) {
  const port = validatePort(value);
  await mkdir(directory, { recursive: true });
  const target = join(directory, 'desktop-settings.json');
  const temp = `${target}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify({ port }, null, 2), { mode: 0o600 }); await rename(temp, target); }
  finally { await unlink(temp).catch(() => {}); }
  return port;
}
module.exports = { DEFAULT_PORT, validatePort, readPort, savePort };
