function required(proxy, key) {
  const value = proxy[key];
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).length === 0) throw new Error(`缺少 ${key}`);
  return String(value);
}

function endpoint(proxy) {
  const server = required(proxy, 'server');
  const port = Number(proxy.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口无效');
  const host = server.includes(':') && !server.startsWith('[') ? `[${server}]` : server;
  // 用 URL 验证主机名，防止无效节点破坏整个订阅。
  const parsed = new URL(`https://${host}:${port}`);
  if ((parsed.port && Number(parsed.port) !== port) || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error('服务器地址无效');
  }
  return { server, host, port };
}

function transport(proxy, params) {
  const network = proxy.network || 'tcp';
  if (!['tcp', 'ws', 'grpc'].includes(network)) throw new Error('不支持的传输方式');
  params.set('type', network);
  if (network === 'ws') {
    const options = proxy['ws-opts'] || {};
    if (options['early-data-header-name']) throw new Error('暂不支持 WebSocket early data');
    if (options.path) params.set('path', options.path);
    const headers = options.headers || {};
    const host = headers.Host || headers.host;
    if (host) params.set('host', host);
  }
  if (network === 'grpc') {
    const options = proxy['grpc-opts'] || {};
    if (options['grpc-service-name']) params.set('serviceName', options['grpc-service-name']);
  }
  return network;
}

function tls(proxy, params) {
  const reality = proxy['reality-opts'];
  const secure = !!proxy.tls || !!reality;
  params.set('security', reality ? 'reality' : secure ? 'tls' : 'none');
  if (secure) {
    if (proxy.servername || proxy.sni) params.set('sni', proxy.servername || proxy.sni);
    if (proxy['client-fingerprint']) params.set('fp', proxy['client-fingerprint']);
    if (Array.isArray(proxy.alpn) && proxy.alpn.length) params.set('alpn', proxy.alpn.join(','));
    if (proxy['skip-cert-verify']) params.set('allowInsecure', '1');
  }
  if (reality) {
    params.set('pbk', required(reality, 'public-key'));
    if (reality['short-id']) params.set('sid', reality['short-id']);
    if (reality['spider-x']) params.set('spx', reality['spider-x']);
  }
}

function share(protocol, credentials, proxy, params) {
  const { host, port } = endpoint(proxy);
  const query = params?.toString();
  return `${protocol}://${credentials}@${host}:${port}${query ? `?${query}` : ''}#${encodeURIComponent(proxy.name)}`;
}

export function toShareLink(proxy) {
  if (!proxy || typeof proxy.name !== 'string' || !proxy.name) throw new Error('节点名称无效');
  const { server, port } = endpoint(proxy);
  if (proxy['dialer-proxy']) throw new Error('前置代理不能表示为独立链接');
  switch (proxy.type) {
    case 'ss': {
      if (proxy.plugin) throw new Error('暂不支持 SS 插件');
      const userinfo = Buffer.from(`${required(proxy, 'cipher')}:${required(proxy, 'password')}`).toString('base64url');
      return share('ss', userinfo, proxy);
    }
    case 'vmess': {
      const params = new URLSearchParams();
      const network = transport(proxy, params);
      const json = {
        v: '2', ps: proxy.name, add: server, port: String(port), id: required(proxy, 'uuid'),
        aid: String(proxy.alterId ?? 0), scy: proxy.cipher || 'auto', net: network,
        type: 'none', host: params.get('host') || '', path: params.get('path') || params.get('serviceName') || '',
        tls: proxy.tls ? 'tls' : '', sni: proxy.servername || proxy.sni || '',
        alpn: Array.isArray(proxy.alpn) ? proxy.alpn.join(',') : '', fp: proxy['client-fingerprint'] || '',
      };
      if (proxy['reality-opts']) throw new Error('暂不支持 VMess Reality');
      return `vmess://${Buffer.from(JSON.stringify(json)).toString('base64')}`;
    }
    case 'vless': {
      const params = new URLSearchParams({ encryption: 'none' });
      tls(proxy, params); transport(proxy, params);
      if (proxy.flow) params.set('flow', proxy.flow);
      return share('vless', encodeURIComponent(required(proxy, 'uuid')), proxy, params);
    }
    case 'trojan': {
      const params = new URLSearchParams();
      tls({ ...proxy, tls: true }, params); transport(proxy, params);
      return share('trojan', encodeURIComponent(required(proxy, 'password')), proxy, params);
    }
    case 'hysteria2': {
      if (proxy.ports) throw new Error('暂不支持端口跳跃');
      const params = new URLSearchParams();
      if (proxy.sni) params.set('sni', proxy.sni);
      if (proxy['skip-cert-verify']) params.set('insecure', '1');
      if (Array.isArray(proxy.alpn) && proxy.alpn.length) params.set('alpn', proxy.alpn.join(','));
      if (proxy.obfs) { params.set('obfs', proxy.obfs); params.set('obfs-password', required(proxy, 'obfs-password')); }
      return share('hysteria2', encodeURIComponent(required(proxy, 'password')), proxy, params);
    }
    case 'tuic': {
      const params = new URLSearchParams();
      if (proxy.sni) params.set('sni', proxy.sni);
      if (proxy['skip-cert-verify']) params.set('allow_insecure', '1');
      if (Array.isArray(proxy.alpn) && proxy.alpn.length) params.set('alpn', proxy.alpn.join(','));
      if (proxy['congestion-controller']) params.set('congestion_control', proxy['congestion-controller']);
      if (proxy['udp-relay-mode']) params.set('udp_relay_mode', proxy['udp-relay-mode']);
      return share('tuic', `${encodeURIComponent(required(proxy, 'uuid'))}:${encodeURIComponent(required(proxy, 'password'))}`, proxy, params);
    }
    default: throw new Error('不支持的节点协议');
  }
}

export function makeV2rayNSubscription(proxies) {
  const links = []; const unsupported = {};
  for (const proxy of proxies) {
    try { links.push(toShareLink(proxy)); }
    catch { const type = String(proxy?.type || 'unknown'); unsupported[type] = (unsupported[type] || 0) + 1; }
  }
  return { body: Buffer.from(links.join('\n')).toString('base64'), count: links.length,
    skipped: proxies.length - links.length, unsupported };
}
