import settings from '../config.json' with { type: 'json' };
import {
  formatNotification,
  getMonitorSettings,
  validateMonitorSettings
} from './monitor-settings.js';

const defaultSource = 'https://geekhaven.pt/collections/pokemon';

export function sourcesFor(values = [defaultSource]) {
  if (!Array.isArray(values) || !values.length) throw new Error('Invalid config: sources');
  const sources = values.map(value => {
    if (typeof value !== 'string') throw new Error('Invalid config: sources');
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Invalid config: source URL');
    url.hash = '';
    let type;
    if (['continente.pt', 'www.continente.pt'].includes(url.hostname)) {
      url.hostname = 'www.continente.pt';
      const path = url.pathname.replace(/\/$/, '') || '/';
      if (/^\/produto\/[^/]+-\d+\.html$/.test(path)) {
        url.pathname = path; url.search = ''; type = 'continente';
      } else if (path === '/pesquisa') {
        const allowlist = ['pmax', 'pmin', 'q', 'srule', 'start', 'sz'];
        const raw = url.search.startsWith('?') ? url.search.slice(1) : url.search;
        const allowedKeys = [];
        for (const part of raw.split('&')) {
          if (!part) continue;
          const key = decodeURIComponent(part.split('=')[0].replace(/\+/g, ' '));
          if (allowlist.includes(key)) allowedKeys.push(key);
        }
        if (new Set(allowedKeys).size !== allowedKeys.length) throw new Error('Invalid config: Continente search URL');
        const q = url.searchParams.get('q');
        if (typeof q !== 'string' || !q.trim()) throw new Error('Invalid config: Continente search URL');
        const start = url.searchParams.get('start');
        if (start !== null && !/^\d+$/.test(start)) throw new Error('Invalid config: Continente search URL');
        const sz = url.searchParams.get('sz');
        if (sz !== null && !/^[1-9]\d*$/.test(sz)) throw new Error('Invalid config: Continente search URL');
        const params = new URLSearchParams();
        for (const key of allowlist) {
          if (!url.searchParams.has(key)) continue;
          params.set(key, key === 'q' ? q.trim() : url.searchParams.get(key));
        }
        url.pathname = '/pesquisa/';
        url.search = params.toString() ? `?${params.toString()}` : '';
        type = 'continente-search';
      } else throw new Error('Invalid config: Continente product URL');
    } else {
      url.search = '';
      url.pathname = url.pathname.replace(/\/$/, '');
      if (/^\/collections\/[^/]+(?:\/products\.json)?$/.test(url.pathname)) {
        url.pathname = url.pathname.replace(/\/products\.json$/, ''); type = 'collection';
      } else if (/^\/products\/[^/.]+(?:\.json)?$/.test(url.pathname)) {
        url.pathname = url.pathname.replace(/\.json$/, ''); type = 'product';
      } else throw new Error('Invalid config: unsupported source URL');
    }
    return { url: url.href, origin: url.origin, type };
  });
  if (new Set(sources.map(s => s.url)).size !== sources.length) throw new Error('Invalid config: duplicate sources');
  return sources;
}

export function shopifyProducts(products, source) {
  if (!Array.isArray(products) || products.some(p => !p.id || typeof p.title !== 'string' || !p.title.trim() || typeof p.handle !== 'string' || !p.handle || !Array.isArray(p.variants) || !p.variants.length || p.variants.some(v => typeof v.available !== 'boolean'))) throw new Error('Invalid product feed');
  return products.map(p => ({ id: `${source.origin}:${p.id}`, title: p.title, available: p.variants.some(v => v.available), url: `${source.origin}/products/${encodeURIComponent(p.handle)}` }));
}

export function continenteProduct(html, source) {
  const sku = source.url.match(/-(\d+)\.html$/)[1];
  const products = [];
  const visit = node => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== 'object') return;
    if ([node['@type']].flat().includes('Product')) products.push(node);
    if (node['@graph']) visit(node['@graph']);
  };
  for (const script of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try { visit(JSON.parse(script[1])); } catch { throw new Error('Invalid product feed'); }
  }
  const matches = products.filter(p => String(p.sku) === sku);
  if (matches.length !== 1 || typeof matches[0].name !== 'string' || !matches[0].name.trim()) throw new Error('Invalid product feed');
  const offers = [matches[0].offers].flat();
  const statuses = offers.map(o => {
    if (typeof o?.availability !== 'string') return null;
    if (/^https?:\/\/schema\.org\/InStock$/.test(o.availability)) return true;
    if (/^https?:\/\/schema\.org\/(OutOfStock|SoldOut|Discontinued)$/.test(o.availability)) return false;
    return null;
  });
  if (!statuses.length || statuses.includes(null) || new Set(statuses).size !== 1) throw new Error('Invalid product feed');
  let available = statuses[0];
  for (const match of html.matchAll(/<div\b([^>]*)>/gi)) {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/g)].map(m => [m[1].toLowerCase(), m[2]]));
    const tokens = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
    if (!tokens.has('product-detail') || attrs['data-pid'] !== sku) continue;
    if (attrs['data-is-product-out-of-stock'] !== undefined && !['true', 'false'].includes(attrs['data-is-product-out-of-stock'])) throw new Error('Invalid product feed');
    if (attrs['data-is-product-out-of-stock'] === 'true' || tokens.has('product-out-of-stock')) available = false;
  }
  for (const match of html.matchAll(/<button\b([^>]*)>/gi)) {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/g)].map(m => [m[1].toLowerCase(), m[2]]));
    if (attrs['data-container'] !== 'pdp' || attrs['data-pid'] !== sku) continue;
    if (attrs['data-outofstock'] !== undefined && !['true', 'false'].includes(attrs['data-outofstock'])) throw new Error('Invalid product feed');
    if (attrs['data-outofstock'] === 'true' || /(?:^|\s)disabled(?:\s|=|$)/i.test(match[1])) available = false;
  }
  return [{ id: `${source.origin}:${sku}`, title: matches[0].name, available, url: source.url }];
}

export function continenteSearchPage(html, origin) {
  const footer = [...html.matchAll(/<div\b([^>]*)>/gi)].map(match => {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/g)].map(m => [m[1].toLowerCase(), m[2]]));
    return { attrs, index: match.index, tokens: new Set((attrs.class || '').split(/\s+/).filter(Boolean)) };
  }).find(entry => entry.tokens.has('grid-footer'));
  if (!footer) throw new Error('Invalid product feed');
  const totalRaw = footer.attrs['data-total-count'];
  const sizeRaw = footer.attrs['data-page-size'];
  const pageRaw = footer.attrs['data-page-number'];
  if (!/^\d+$/.test(totalRaw || '') || !/^\d+(?:\.\d+)?$/.test(sizeRaw || '') || !/^\d+$/.test(pageRaw || '')) throw new Error('Invalid product feed');
  const totalCount = Number(totalRaw);
  const pageSize = Number(sizeRaw);
  const pageNumber = Number(pageRaw);
  if (!Number.isInteger(totalCount) || totalCount < 0 || !(pageSize > 0) || pageSize !== Math.floor(pageSize) || !Number.isInteger(pageNumber) || pageNumber < 0) throw new Error('Invalid product feed');
  if (totalCount === 0) return { links: [], totalCount, pageSize, pageNumber };
  const tiles = [];
  for (const match of html.matchAll(/<div\b([^>]*)>/gi)) {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/g)].map(m => [m[1].toLowerCase(), m[2]]));
    const tokens = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
    if (!tokens.has('product') || tokens.has('product-tile') || tokens.has('product-detail') || !/^\d+$/.test(attrs['data-pid'] || '')) continue;
    tiles.push({ pid: attrs['data-pid'], index: match.index, end: match.index + match[0].length });
  }
  const links = [];
  const seen = new Set();
  for (let i = 0; i < tiles.length; i++) {
    const chunk = html.slice(tiles[i].end, i + 1 < tiles.length ? tiles[i + 1].index : footer.index);
    for (const href of [...chunk.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)].map(m => m[1])) {
      let product;
      try { product = new URL(href, origin); } catch { continue; }
      if (product.origin !== origin) continue;
      const matched = product.pathname.match(/^\/produto\/[^/]+-(\d+)\.html$/);
      if (!matched || matched[1] !== tiles[i].pid) continue;
      if (!seen.has(matched[1])) {
        seen.add(matched[1]);
        links.push(`${origin}${product.pathname}`);
      }
      break;
    }
  }
  if (!links.length) throw new Error('Invalid product feed');
  return { links, totalCount, pageSize, pageNumber };
}

export function changesFor(products, known, config) {
  const events = [];
  for (const p of products) {
    if (typeof p.available !== 'boolean') continue;
    const available = p.available;
    const prior = known[String(p.id)];
    const kind = prior === undefined ? 'NEW PRODUCT' : prior.available === false && available ? 'RESTOCK' : null;
    if (!kind) continue;
    if (kind === 'NEW PRODUCT' && (!config.alertOnNewProducts || (!available && !config.alertOnSoldOutListings))) continue;
    if (kind === 'RESTOCK' && !config.alertOnRestocks) continue;
    const name = p.title.toLowerCase();
    if (config.includeKeywords.length && !config.includeKeywords.some(w => name.includes(w.toLowerCase()))) continue;
    if (config.excludeKeywords.some(w => name.includes(w.toLowerCase()))) continue;
    events.push({ kind, title: p.title, available, url: p.url });
  }
  return events;
}

async function storeFetch(fetcher, url, headers) {
  const response = await fetcher(url, { headers, signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok) {
    const error = new Error(`Store HTTP ${response.status}`);
    error.retryAfter = response.headers.get('Retry-After');
    error.blocked = [401,403].includes(response.status);
    throw error;
  }
  return response;
}

async function readContinenteSearch(source, fetcher) {
  const headers = { Accept: 'text/html', 'User-Agent': 'GeekHavenPersonalMonitor/1.0' };
  const base = new URL(source.url);
  const seen = new Set();
  const links = [];
  const initialStart = base.searchParams.has('start') ? Number(base.searchParams.get('start')) : 0;
  let start = initialStart;
  let totalCount = null;
  let pageSize = null;
  for (let page = 1; page <= 5; page++) {
    const pageUrl = new URL(base.href);
    pageUrl.searchParams.set('start', String(start));
    const html = await (await storeFetch(fetcher, pageUrl.href, headers)).text();
    const result = continenteSearchPage(html, source.origin);
    if (start !== result.pageNumber * result.pageSize) throw new Error('Invalid product feed');
    if (totalCount === null) {
      totalCount = result.totalCount;
      pageSize = result.pageSize;
      if (totalCount > 30 || Math.ceil((totalCount || 1) / pageSize) > 5) throw new Error('Search exceeds pagination limit');
      if (totalCount === 0) return { products: [], etag: null };
    } else if (result.totalCount !== totalCount || result.pageSize !== pageSize) throw new Error('Invalid product feed');
    for (const link of result.links) {
      const sku = link.match(/-(\d+)\.html$/)[1];
      if (seen.has(sku)) continue;
      seen.add(sku);
      if (seen.size > 30) throw new Error('Search exceeds pagination limit');
      links.push(link);
    }
    const nextStart = start + pageSize;
    if (nextStart >= totalCount) break;
    if (page === 5) throw new Error('Search exceeds pagination limit');
    start = nextStart;
  }
  if (links.length !== totalCount - initialStart) throw new Error('Invalid product feed');
  const products = [];
  for (const link of links) {
    const pdp = { url: link, origin: source.origin, type: 'continente' };
    products.push(...continenteProduct(await (await storeFetch(fetcher, link, headers)).text(), pdp));
  }
  return { products, etag: null };
}

async function readSource(source, state, fetcher) {
  if (source.type === 'continente-search') return readContinenteSearch(source, fetcher);
  let products = [], etag = null;
  for (let page = 1; page <= 10; page++) {
    const headers = { Accept: source.type === 'continente' ? 'text/html' : 'application/json', 'User-Agent': 'GeekHavenPersonalMonitor/1.0' };
    if (page === 1 && state.etag) headers['If-None-Match'] = state.etag;
    const url = source.type === 'collection' ? `${source.url}/products.json?limit=250&page=${page}` : source.type === 'product' ? `${source.url}.json` : source.url;
    const response = await fetcher(url, { headers, signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (response.status === 304 && page === 1 && state.initialized) return null;
    if (!response.ok) {
      const error = new Error(`Store HTTP ${response.status}`);
      error.retryAfter = response.headers.get('Retry-After');
      error.blocked = [401,403].includes(response.status);
      throw error;
    }
    if (source.type === 'continente') return { products: continenteProduct(await response.text(), source), etag: response.headers.get('ETag') };
    const body = await response.json();
    const batch = shopifyProducts(source.type === 'product' ? [body.product] : body.products, source);
    products.push(...batch);
    if (source.type === 'product' || batch.length < 250) {
      if (page === 1) etag = response.headers.get('ETag');
      return { products, etag };
    }
    if (page === 10) throw new Error('Collection exceeds pagination limit');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

export function retrySeconds(header, failures, now = Date.now()) {
  const seconds = header && /^\d+(\.\d+)?$/.test(header) ? Number(header) : (Date.parse(header) - now) / 1000;
  return Math.ceil(Math.max(Math.min(3600, 60 * 2 ** Math.min(failures - 1, 6)), Number.isFinite(seconds) ? seconds : 0));
}

function validate(config) {
  for (const key of ['enabled','alertOnNewProducts','alertOnRestocks','alertOnSoldOutListings']) {
    if (typeof config[key] !== 'boolean') throw new Error(`Invalid config: ${key}`);
  }
  for (const key of ['includeKeywords','excludeKeywords']) {
    if (!Array.isArray(config[key]) || config[key].some(w => typeof w !== 'string' || !w.trim())) throw new Error(`Invalid config: ${key}`);
  }
}

function webhookURL(env) {
  const url = new URL(env.DISCORD_WEBHOOK_URL);
  if (url.protocol !== 'https:' || url.hostname !== 'discord.com' || !/^\/api\/webhooks\/\d+\/[\w-]+$/.test(url.pathname)) throw new Error('Invalid DISCORD_WEBHOOK_URL secret');
  url.searchParams.set('wait', 'true');
  return url;
}

function successDelayMs(config) {
  const seconds = Number.isInteger(config.checkIntervalSeconds) ? config.checkIntervalSeconds : 60;
  return Math.max(55000, seconds * 1000 - 5000);
}

function notificationSettingsFrom(config) {
  if (!config || config.mentionUserIds == null || config.messageTemplate == null || config.webhookUsername == null) return undefined;
  try {
    return validateMonitorSettings({
      enabled: typeof config.enabled === 'boolean' ? config.enabled : true,
      alertOnNewProducts: typeof config.alertOnNewProducts === 'boolean' ? config.alertOnNewProducts : true,
      alertOnRestocks: typeof config.alertOnRestocks === 'boolean' ? config.alertOnRestocks : true,
      alertOnSoldOutListings: typeof config.alertOnSoldOutListings === 'boolean' ? config.alertOnSoldOutListings : false,
      includeKeywords: Array.isArray(config.includeKeywords) ? config.includeKeywords : [],
      excludeKeywords: Array.isArray(config.excludeKeywords) ? config.excludeKeywords : [],
      checkIntervalSeconds: Number.isInteger(config.checkIntervalSeconds) ? config.checkIntervalSeconds : 60,
      mentionUserIds: config.mentionUserIds,
      messageTemplate: config.messageTemplate,
      webhookUsername: config.webhookUsername
    });
  } catch {
    return undefined;
  }
}

export async function sendDiscord(env, event, fetcher = fetch, notificationSettings) {
  const extras = notificationSettings
    ? formatNotification(event, notificationSettings)
    : { username: 'Geek Haven Monitor', allowed_mentions: { parse: [] } };
  const payload = {
    username: extras.username,
    allowed_mentions: extras.allowed_mentions,
    embeds: [{ title: `${event.kind}: ${event.title}`.slice(0, 256), url: event.url,
      description: event.available ? 'In stock' : 'Sold out', color: event.kind === 'TEST' ? 3447003 : 5763719 }]
  };
  if (extras.content !== undefined) payload.content = extras.content;
  const response = await fetcher(webhookURL(env), {
    method: 'POST', signal: AbortSignal.timeout(10000), redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const error = new Error(`Discord HTTP ${response.status}`);
    error.retryAfter = response.headers.get('Retry-After');
    // Discord may specify its retry delay in the JSON body.
    if (response.status === 429) {
      const body = await response.json().catch(() => ({}));
      if (body.retry_after != null) error.retryAfter = String(body.retry_after);
    }
    throw error;
  }
  await response.arrayBuffer();
}

function resolveSources(values) {
  if (Array.isArray(values) && values.length === 0) return [];
  return sourcesFor(values);
}

function defaultSourceUrls(values = settings.sources) {
  return sourcesFor(values ?? undefined).map(s => s.url);
}

export async function configuredCheck(env, config = settings, fetcher = fetch) {
  const { getSources } = await import('./discord-links.js');
  const configured = await getSources(env, defaultSourceUrls(config.sources));
  const runtime = await getMonitorSettings(env, settings);
  return runCheck(env, { ...runtime, sources: configured }, fetcher);
}

export async function testSourceUrl(rawUrl, fetcher = fetch) {
  const source = sourcesFor([rawUrl])[0];
  const deadline = AbortSignal.timeout(20000);
  const bounded = (url, options = {}) => {
    const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
    return fetcher(url, { ...options, signal });
  };
  let result;
  try {
    result = await readSource(source, {}, bounded);
  } catch (error) {
    if (deadline.aborted) throw new Error('Request or processing failed');
    throw error;
  }
  if (deadline.aborted) throw new Error('Request or processing failed');
  const products = result?.products || [];
  let available = 0, unavailable = 0, unknown = 0;
  for (const p of products) {
    if (p.available === true) available++;
    else if (p.available === false) unavailable++;
    else unknown++;
  }
  return { url: source.url, products: products.length, available, unavailable, unknown };
}

export async function getMonitorStatus(env, config = settings) {
  const { getSources } = await import('./discord-links.js');
  const runtime = await getMonitorSettings(env, settings);
  const configured = await getSources(env, defaultSourceUrls(config.sources));
  const row = await env.DB.prepare('SELECT state FROM monitor WHERE id = 1').first();
  const parsed = row?.state ? JSON.parse(row.state) : {};
  const { known, pending, ...state } = parsed;
  const sources = Object.fromEntries(Object.entries(state.sources || {}).map(([url, { known: _k, ...history }]) => [url, history]));
  return {
    ...state,
    configured,
    sources,
    pending: pending?.length || 0,
    enabled: runtime.enabled,
    settings: runtime
  };
}

export async function sendTestNotification(env, config = settings, fetcher = fetch) {
  const runtime = await getMonitorSettings(env, settings);
  await sendDiscord(env, {
    kind: 'TEST',
    title: 'Notifications are working - this is not a real drop',
    available: true,
    url: 'https://geekhaven.pt/collections/pokemon'
  }, fetcher, runtime);
  return { status: 'test sent' };
}

export async function runCheck(env, config = settings, fetcher = fetch) {
  config = { alertOnSoldOutListings: false, ...config };
  validate(config);
  const sources = resolveSources(config.sources);
  const notificationSettings = notificationSettingsFrom(config);
  if (!config.enabled) return { status: 'paused' };
  const token = crypto.randomUUID();
  const now = Date.now();
  const locked = await env.DB.prepare('UPDATE monitor SET lease_until = ?, lease_token = ? WHERE id = 1 AND lease_until < ?')
    .bind(now + 180000, token, now).run();
  if (!locked.meta.changes) return { status: 'busy' };
  const save = async state => {
    const result = await env.DB.prepare('UPDATE monitor SET state = ? WHERE id = 1 AND lease_token = ?')
      .bind(JSON.stringify(state), token).run();
    if (!result.meta.changes) throw new Error('Monitor lease lost');
  };
  try {
    const row = await env.DB.prepare('SELECT state FROM monitor WHERE id = 1').first();
    const state = { pending: [], ...JSON.parse(row.state) };
    if (!state.sources) {
      state.sources = {};
      if (state.initialized || state.known) {
        const known = Object.fromEntries(Object.entries(state.known || {}).map(([id, p]) => [`https://geekhaven.pt:${id}`, p]));
        state.sources[defaultSource] = { known, initialized: state.initialized, etag: state.etag, productCount: state.productCount, blocked: state.blocked, lastError: state.lastError, nextCheck: state.nextCheck, failures: state.failures };
      }
      for (const key of ['known', 'initialized', 'etag', 'productCount', 'blocked', 'lastError', 'nextCheck', 'failures']) delete state[key];
    }
    if (state.nextCheck > now) return { status: 'waiting', nextCheck: state.nextCheck };
    const active = new Set(sources.map(s => s.url));
    state.pending = state.pending.filter(event => !event.sourceUrl || active.has(event.sourceUrl));
    const errors = [];
    try {
      if (!sources.length) {
        await save(state);
        return { status: 'no_sources', errors, products: 0, sent: 0, pending: state.pending.length };
      }
      webhookURL(env); // Fail before recording any products if notification setup is missing.
      // Persisted outbox is drained before fetching again so a webhook outage loses no alerts.
      if (!state.pending.length) {
        for (const source of sources) {
          const history = state.sources[source.url] ||= { known: {} };
          if (history.blocked) { errors.push({ source: source.url, status: 'blocked', error: history.lastError }); continue; }
          if (history.nextCheck > now) continue;
          try {
            const result = await readSource(source, history, fetcher);
            if (result) {
              const events = history.initialized ? changesFor(result.products, history.known, config) : [];
              for (const p of result.products) history.known[p.id] = { available: p.available };
              for (const event of events) {
                const tagged = { ...event, sourceUrl: source.url };
                if (!state.pending.some(p => p.url === event.url && p.kind === event.kind)) state.pending.push(tagged);
              }
              history.initialized = true;
              history.etag = result.etag;
              history.productCount = result.products.length;
            }
            history.lastCheck = Date.now();
            history.failures = 0;
            history.lastError = null;
            history.nextCheck = Date.now() + successDelayMs(config);
          } catch (error) {
            history.failures = (history.failures || 0) + 1;
            history.lastError = /^(Store HTTP \d+|Invalid product feed|Collection exceeds pagination limit|Search exceeds pagination limit)$/.test(error.message) ? error.message : 'Request or processing failed';
            history.blocked = Boolean(error.blocked);
            history.nextCheck = Date.now() + retrySeconds(error.retryAfter, history.failures) * 1000;
            errors.push({ source: source.url, status: history.blocked ? 'blocked' : 'error', error: history.lastError });
          }
          await save(state); // Save each source and alerts before sending them.
        }
      }
      state.pending = state.pending.filter(event => !event.sourceUrl || active.has(event.sourceUrl));
      let sent = 0;
      while (state.pending.length && sent < 5) {
        await sendDiscord(env, state.pending[0], fetcher, notificationSettings);
        state.pending.shift();
        sent++;
        await save(state);
      }
      state.failures = 0;
      state.lastError = null;
      state.nextCheck = Date.now() + successDelayMs(config);
      await save(state);
      return { status: errors.length === sources.length ? (errors.every(e => e.status === 'blocked') ? 'blocked' : 'error') : 'ok', errors, products: sources.reduce((n, s) => n + (state.sources[s.url]?.productCount || 0), 0), sent, pending: state.pending.length };
    } catch (error) {
      state.failures = (state.failures || 0) + 1;
      // Store fixed messages only; fetch exception text can contain secret URLs.
      state.lastError = /^(Store HTTP|Discord HTTP|Invalid product feed|Collection exceeds|Search exceeds)/.test(error.message) ? error.message : 'Request or processing failed; check Worker logs';
      state.nextCheck = Date.now() + retrySeconds(error.retryAfter, state.failures) * 1000;
      await save(state);
      return { status: 'error', error: state.lastError, nextCheck: state.nextCheck };
    }
  } finally {
    await env.DB.prepare('UPDATE monitor SET lease_until = 0, lease_token = NULL WHERE id = 1 AND lease_token = ?').bind(token).run();
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(configuredCheck(env).then(result => console.log(JSON.stringify(result))));
  },
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    // Interactions (including signed PING) must not touch monitor_settings / D1.
    if (request.method === 'POST' && path === '/interactions') {
      const { handleLinksInteraction } = await import('./discord-links.js');
      return handleLinksInteraction(
        request,
        env,
        defaultSourceUrls(),
        url => sourcesFor([url])[0].url,
        {
          settingsDefaults: settings,
          testSource: rawUrl => testSourceUrl(rawUrl),
          sendTest: () => sendTestNotification(env),
          getStatus: () => getMonitorStatus(env),
          waitUntil: ctx?.waitUntil ? promise => ctx.waitUntil(promise) : undefined,
          fetcher: fetch
        }
      );
    }
    if (path === '/health') {
      try {
        const runtime = await getMonitorSettings(env, settings);
        return Response.json({ service: 'geekhaven-monitor', enabled: runtime.enabled });
      } catch {
        return Response.json({ error: 'Service unavailable' }, { status: 503 });
      }
    }
    if (!env.ADMIN_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.ADMIN_TOKEN}`) return new Response('Unauthorized', { status: 401 });
    try {
      if (request.method === 'GET' && path === '/status') {
        return Response.json(await getMonitorStatus(env));
      }
      if (request.method === 'POST' && path === '/test') {
        return Response.json(await sendTestNotification(env));
      }
      if (request.method === 'POST' && path === '/check') return Response.json(await configuredCheck(env));
      return new Response('Not found', { status: 404 });
    } catch (error) {
      if (error && error.message === 'Discord HTTP 429') {
        return Response.json({ error: 'Rate limited' }, { status: 429 });
      }
      return Response.json({ error: 'Operation failed. Check database bindings and secrets.' }, { status: 500 });
    }
  }
};
