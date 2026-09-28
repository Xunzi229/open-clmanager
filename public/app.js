const $ = selector => document.querySelector(selector);
if (window.desktop) {
  $('#desktop-controls').hidden = false;
  $('#desktop-address').textContent = `订阅地址正在 ${location.host} 提供服务`;
  $('#desktop-port').value = location.port;
  $('#apply-port').addEventListener('click', async () => {
    if (dirty) { toast('请先保存订阅修改，再更改端口', true); return; }
    $('#apply-port').disabled = true;
    try { await window.desktop.setPort($('#desktop-port').value); }
    catch (error) { $('#apply-port').disabled = false; toast(error.message?.includes('1024') ? '端口必须是 1024～65535 的整数' : '更改端口失败', true); }
  });
  $('#open-browser').addEventListener('click', () => window.desktop.openBrowser());
  $('#stop-service').addEventListener('click', async () => {
    if (dirty && !confirm('还有未保存的修改，确定停止服务吗？')) return;
    $('#stop-service').disabled = true;
    $('#stop-service').textContent = '正在停止…';
    try { await window.desktop.stop(); }
    catch { $('#stop-service').disabled = false; $('#stop-service').textContent = '停止服务'; toast('停止失败，请重试', true); }
  });
}
let config, dirty = false, busy = false, toastTimer;
function toast(message, error = false) {
  clearTimeout(toastTimer); const el = $('#toast'); el.textContent = message; el.classList.toggle('error', error); el.hidden = false;
  toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
}
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '请求失败'); return data;
}
function markDirty() { dirty = true; $('#save-state').textContent = '有未保存的更改'; }
function stats() {
  $('#total').replaceChildren(document.createTextNode(String(config.sources.length)), Object.assign(document.createElement('small'), { textContent: ' 个' }));
  $('#enabled').textContent = config.sources.filter(s => s.enabled).length;
  $('#nodes').textContent = config.sources.filter(s => s.enabled).reduce((n, s) => n + (s.nodeCount || 0), 0);
  $('#ttl').textContent = config.cacheMinutes + ' 分钟';
  $('#source-count').textContent = config.sources.length;
}
function render() {
  stats(); $('#sources').replaceChildren(); $('#empty').hidden = config.sources.length > 0;
  $('#cache-minutes').value = config.cacheMinutes; $('#rule-mode').value = config.ruleMode;
  $('#subscription-url').value = `${location.origin}/sub?token=${config.token}`;
  config.sources.forEach((source, index) => {
    const card = $('#source-template').content.firstElementChild.cloneNode(true);
    card.querySelector('.source-index').textContent = String(index + 1).padStart(2, '0');
    const name = card.querySelector('.source-name'); name.value = source.name;
    name.addEventListener('input', () => { source.name = name.value; markDirty(); });
    const url = card.querySelector('.source-url'); url.value = source.url;
    url.addEventListener('input', () => { source.url = url.value.trim(); source.updatedAt = null; source.nodeCount = 0; source.error = null; stats(); markDirty(); card.querySelector('.source-meta').textContent = '地址已修改，保存后重新拉取'; });
    const enabled = card.querySelector('.source-enabled'); enabled.checked = source.enabled;
    enabled.addEventListener('change', () => { source.enabled = enabled.checked; stats(); markDirty(); });
    card.querySelector('.remove').addEventListener('click', () => { config.sources.splice(index, 1); markDirty(); render(); });
    const meta = card.querySelector('.source-meta');
    const updated = source.updatedAt ? `缓存于 ${new Date(source.updatedAt).toLocaleString('zh-CN')} · ${source.nodeCount} 个静态节点` : '等待首次获取';
    meta.textContent = source.error ? `${source.error} · ${source.updatedAt ? '已保留旧缓存' : '暂无可用缓存'}` : `${updated}${source.stale ? ' · 缓存已过期，等待更新' : ''}`;
    meta.classList.toggle('warning', !!source.error || source.stale); $('#sources').append(card);
  });
}
function add() { if (busy) return; config.sources.push({ id: crypto.randomUUID(), name: `订阅 ${config.sources.length + 1}`, url: '', enabled: true }); markDirty(); render(); $('#sources').lastElementChild.querySelector('.source-name').focus(); }
function lock(value) { busy = value; document.querySelectorAll('main button, main input:not([readonly]), main select').forEach(el => { el.disabled = value; }); }
async function save() {
  if (busy) return; lock(true);
  try {
    config = await api('/api/config', 'PUT', config); dirty = false; $('#save-state').textContent = '配置已保存，正在更新缓存…'; render(); lock(true);
    config = await api('/api/refresh', 'POST', {}); render(); $('#save-state').textContent = '配置已保存到本机';
    const failed = config.sources.filter(s => s.enabled && s.error).length;
    toast(failed ? `配置已保存，${failed} 个来源更新失败，详情见订阅状态` : '配置已保存，缓存已更新', !!failed);
  } catch (error) { toast(error.message, true); $('#save-state').textContent = dirty ? '保存失败，更改仍未保存' : '配置已保存，缓存更新未完成'; }
  finally { lock(false); }
}
$('#add').addEventListener('click', add); $('#empty-add').addEventListener('click', add); $('#save').addEventListener('click', save);
$('#cache-minutes').addEventListener('input', event => { config.cacheMinutes = Number(event.target.value); stats(); markDirty(); });
$('#rule-mode').addEventListener('change', event => { config.ruleMode = event.target.value; markDirty(); });
$('#copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#subscription-url').value); toast('订阅地址已复制'); }
  catch { $('#subscription-url').select(); toast('请按 Ctrl+C 复制订阅地址'); }
});
$('#refresh').addEventListener('click', async () => {
  if (dirty) { toast('请先保存修改，再刷新缓存', true); return; }
  lock(true); $('#refresh').textContent = '正在刷新…';
  try { config = await api('/api/refresh', 'POST', {}); render(); const failed = config.sources.filter(s => s.enabled && s.error).length; toast(failed ? `${failed} 个来源更新失败，详情见订阅状态` : '缓存已更新', !!failed); }
  catch (error) { toast(error.message, true); }
  finally { lock(false); $('#refresh').textContent = '↻ 刷新缓存'; }
});
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
lock(true);
api('/api/config').then(data => { config = data; render(); lock(false); }).catch(error => toast(`无法加载配置：${error.message}，请刷新页面重试`, true));
setInterval(async () => { if (!config || dirty || busy || document.querySelector('.source-card input:focus')) return; try { const data = await api('/api/config'); if (!dirty && !busy) { config = data; render(); } } catch { /* 后台轮询失败不覆盖用户输入。 */ } }, 15000);
