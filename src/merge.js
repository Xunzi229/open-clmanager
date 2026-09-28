import YAML from 'yaml';

const BUILTINS = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE']);
export const MAIN_GROUP = '订阅汇总';

export function parseSubscription(text) {
  const doc = YAML.parse(text, { maxAliasCount: 100, uniqueKeys: true });
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('响应不是有效的 Clash YAML 配置');
  for (const key of ['proxies', 'proxy-groups', 'rules']) {
    if (doc[key] !== undefined && !Array.isArray(doc[key])) throw new Error(`${key} 必须是列表`);
  }
  for (const key of ['proxy-providers', 'rule-providers']) {
    if (doc[key] !== undefined && (!doc[key] || typeof doc[key] !== 'object' || Array.isArray(doc[key]))) throw new Error(`${key} 必须是对象`);
  }
  if (!doc.proxies?.length && !Object.keys(doc['proxy-providers'] || {}).length) throw new Error('未找到节点或 proxy-providers，请使用 Clash YAML 订阅');
  const names = new Set();
  for (const item of [...(doc.proxies || []), ...(doc['proxy-groups'] || [])]) {
    if (!item || typeof item.name !== 'string' || !item.name.trim() || typeof item.type !== 'string') throw new Error('节点或策略组缺少 name / type');
    if (names.has(item.name) || BUILTINS.has(item.name)) throw new Error('节点或策略组名称重复或使用了内置名称');
    names.add(item.name);
  }
  for (const key of ['proxy-providers', 'rule-providers']) {
    for (const provider of Object.values(doc[key] || {})) {
      if (!provider || provider.type !== 'http' || typeof provider.url !== 'string' || !/^https?:\/\//.test(provider.url)) {
        throw new Error('仅支持 HTTP 类型 provider，本地文件 provider 无法跨客户端合并');
      }
    }
  }
  if (doc.rules?.some(rule => typeof rule !== 'string')) throw new Error('rules 条目必须是字符串');
  for (const group of doc['proxy-groups'] || []) {
    for (const key of ['proxies', 'use']) {
      if (group[key] !== undefined && (!Array.isArray(group[key]) || group[key].some(x => typeof x !== 'string'))) throw new Error(`策略组 ${key} 必须是字符串列表`);
    }
  }
  return doc;
}

export function mergeSubscriptions(entries, ruleMode = 'unified') {
  if (!entries.length) throw new Error('没有可用订阅');
  const proxies = [], groups = [], providers = {}, ruleProviders = {}, choices = [], uses = [];
  let firstRules = [];
  entries.forEach(({ source, config }, index) => {
    const prefix = `${source.name} · ${source.id.slice(0, 8)} / `;
    const rename = name => BUILTINS.has(name) ? name : prefix + name;
    const localProxyNames = (config.proxies || []).map(p => rename(p.name));
    const localProviderNames = Object.keys(config['proxy-providers'] || {}).map(rename);
    const localGroupNames = (config['proxy-groups'] || []).map(g => rename(g.name));
    const known = new Set([...(config.proxies || []).map(p => p.name), ...(config['proxy-groups'] || []).map(g => g.name)]);
    const reference = name => {
      if (!BUILTINS.has(name) && !known.has(name)) throw new Error(`订阅「${source.name}」引用不存在的节点或策略组`);
      return rename(name);
    };
    for (const proxy of config.proxies || []) {
      const next = { ...proxy, name: rename(proxy.name) };
      if (next['dialer-proxy']) next['dialer-proxy'] = reference(next['dialer-proxy']);
      proxies.push(next);
    }
    for (const [name, provider] of Object.entries(config['proxy-providers'] || {})) {
      const next = { ...provider, path: `./providers/${source.id}-${Buffer.from(name).toString('hex')}.yaml` };
      if (next.proxy) next.proxy = reference(next.proxy);
      if (next.override?.['dialer-proxy']) next.override = { ...next.override, 'dialer-proxy': reference(next.override['dialer-proxy']) };
      providers[rename(name)] = next;
    }
    for (const group of config['proxy-groups'] || []) {
      const next = { ...group, name: rename(group.name) };
      if (next.proxies) next.proxies = next.proxies.map(reference);
      if (next.use) next.use = next.use.map(name => {
        if (!Object.hasOwn(config['proxy-providers'] || {}, name)) throw new Error(`订阅「${source.name}」引用不存在的 provider`);
        return rename(name);
      });
      // 将 Mihomo 的全量选择范围限制在该订阅，避免合并后选中自己。
      if (next['include-all'] || next['include-all-proxies'] || next['include-all-providers']) {
        if (next['include-all'] || next['include-all-proxies']) next.proxies = [...new Set([...(next.proxies || []), ...localProxyNames])];
        if (next['include-all'] || next['include-all-providers']) next.use = [...new Set([...(next.use || []), ...localProviderNames])];
        delete next['include-all']; delete next['include-all-proxies']; delete next['include-all-providers'];
      }
      groups.push(next);
    }
    choices.push(...localGroupNames, ...localProxyNames);
    uses.push(...localProviderNames);
    if (index === 0 && ruleMode === 'first') {
      for (const [name, provider] of Object.entries(config['rule-providers'] || {})) {
        ruleProviders[rename(name)] = { ...provider, path: `./rules/${source.id}-${Buffer.from(name).toString('hex')}.${provider.format === 'mrs' ? 'mrs' : 'yaml'}` };
        if (provider.proxy) ruleProviders[rename(name)].proxy = reference(provider.proxy);
      }
      firstRules = (config.rules || []).map(rule => {
        const parts = rule.split(',');
        const target = parts.at(-1)?.trim() === 'no-resolve' ? parts.length - 2 : parts.length - 1;
        if (target < 1 || parts[0].trim() === 'SUB-RULE') throw new Error('规则格式不受支持（不支持 SUB-RULE）');
        parts[target] = reference(parts[target].trim());
        // 包括逻辑规则内部的 RULE-SET 引用。
        return parts.join(',').replace(/\bRULE-SET,([^,()]+)/g, (_, name) => {
          if (!Object.hasOwn(config['rule-providers'] || {}, name.trim())) throw new Error('规则引用不存在的 rule-provider');
          return `RULE-SET,${rename(name.trim())}`;
        });
      });
    }
  });
  const main = { name: MAIN_GROUP, type: 'select', proxies: [...choices, 'DIRECT'] };
  if (uses.length) main.use = uses;
  return {
    'mixed-port': 7890, 'allow-lan': false, mode: 'rule', 'log-level': 'info',
    proxies, 'proxy-groups': [main, ...groups],
    ...(Object.keys(providers).length ? { 'proxy-providers': providers } : {}),
    ...(Object.keys(ruleProviders).length ? { 'rule-providers': ruleProviders } : {}),
    rules: [...firstRules, ...(!firstRules.some(r => /^(MATCH|FINAL),/.test(r)) ? [`MATCH,${MAIN_GROUP}`] : [])],
  };
}
