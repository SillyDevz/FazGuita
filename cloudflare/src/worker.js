import settings from '../config.json' with { type: 'json' };

export function changesFor(products, known, config) {
  const events = [];
  for (const p of products) {
    const available = p.variants.some(v => v.available === true);
    const prior = known[String(p.id)];
    const kind = prior === undefined ? 'NEW PRODUCT' : !prior.available && available ? 'RESTOCK' : null;
    if (!kind) continue;
    if (kind === 'NEW PRODUCT' && (!config.alertOnNewProducts || (!available && !config.alertOnSoldOutListings))) continue;
    if (kind === 'RESTOCK' && !config.alertOnRestocks) continue;
    const name = p.title.toLowerCase();
    if (config.includeKeywords.length && !config.includeKeywords.some(w => name.includes(w.toLowerCase()))) continue;
    if (config.excludeKeywords.some(w => name.includes(w.toLowerCase()))) continue;
    events.push({ kind, title: p.title, available, url: `https://geekhaven.pt/products/${encodeURIComponent(p.handle)}` });
  }
  return events;
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

export async function sendDiscord(env, event, fetcher = fetch) {
  const response = await fetcher(webhookURL(env), {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'Geek Haven Monitor', allowed_mentions: { parse: [] },
      embeds: [{ title: `${event.kind}: ${event.title}`.slice(0, 256), url: event.url,
        description: event.available ? 'In stock' : 'Sold out', color: event.kind === 'TEST' ? 3447003 : 5763719 }]
    })
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

export async function runCheck(env, config = settings, fetcher = fetch) {
  validate(config);
  if (!config.enabled) return { status: 'paused' };
  webhookURL(env); // Fail before recording any products if notification setup is missing.
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
    const state = { known: {}, pending: [], ...JSON.parse(row.state) };
    if (state.nextCheck > now) return { status: 'waiting', nextCheck: state.nextCheck };
    if (state.blocked) return { status: 'blocked', error: state.lastError };
    try {
      // Persisted outbox is drained before fetching again so a webhook outage loses no alerts.
      if (!state.pending.length) {
        let products = [], etag = null, unchanged = false;
        for (let page = 1; page <= 10; page++) {
          const headers = { Accept: 'application/json', 'User-Agent': 'GeekHavenPersonalMonitor/1.0' };
          if (page === 1 && state.etag) headers['If-None-Match'] = state.etag;
          const response = await fetcher(`https://geekhaven.pt/collections/pokemon/products.json?limit=250&page=${page}`, {
            headers, signal: AbortSignal.timeout(10000)
          });
          if (response.status === 304 && page === 1 && state.initialized) { unchanged = true; break; }
          if (!response.ok) {
            const error = new Error(`Store HTTP ${response.status}`);
            error.retryAfter = response.headers.get('Retry-After');
            error.blocked = [401,403].includes(response.status);
            throw error;
          }
          const body = await response.json();
          if (!Array.isArray(body.products) || body.products.some(p => !p.id || typeof p.title !== 'string' || !p.handle || !Array.isArray(p.variants))) throw new Error('Invalid product feed');
          products.push(...body.products);
          if (body.products.length < 250) { if (page === 1) etag = response.headers.get('ETag'); break; }
          if (page === 10) throw new Error('Collection exceeds pagination limit');
          // Space additional page requests; never bypass server throttling.
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (!unchanged) {
          const events = state.initialized ? changesFor(products, state.known, config) : [];
          for (const p of products) state.known[String(p.id)] = { available: p.variants.some(v => v.available === true) };
          state.pending.push(...events);
          state.initialized = true;
          state.etag = etag;
          state.productCount = products.length;
        }
        state.lastCheck = Date.now();
        await save(state); // Save alerts before sending them.
      }
      let sent = 0;
      while (state.pending.length && sent < 5) {
        await sendDiscord(env, state.pending[0], fetcher);
        state.pending.shift();
        sent++;
        await save(state);
      }
      state.failures = 0;
      state.lastError = null;
      state.nextCheck = Date.now() + 55000;
      await save(state);
      return { status: 'ok', products: state.productCount, sent, pending: state.pending.length };
    } catch (error) {
      state.failures = (state.failures || 0) + 1;
      // Store fixed messages only; fetch exception text can contain secret URLs.
      state.lastError = /^(Store HTTP|Discord HTTP|Invalid product feed|Collection exceeds)/.test(error.message) ? error.message : 'Request or processing failed; check Worker logs';
      state.blocked = Boolean(error.blocked);
      state.nextCheck = Date.now() + retrySeconds(error.retryAfter, state.failures) * 1000;
      await save(state);
      return { status: state.blocked ? 'blocked' : 'error', error: state.lastError, nextCheck: state.nextCheck };
    }
  } finally {
    await env.DB.prepare('UPDATE monitor SET lease_until = 0, lease_token = NULL WHERE id = 1 AND lease_token = ?').bind(token).run();
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheck(env).then(result => console.log(JSON.stringify(result))));
  },
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/health') return Response.json({ service: 'geekhaven-monitor', enabled: settings.enabled });
    if (!env.ADMIN_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.ADMIN_TOKEN}`) return new Response('Unauthorized', { status: 401 });
    try {
      if (request.method === 'GET' && path === '/status') {
        const row = await env.DB.prepare('SELECT state FROM monitor WHERE id = 1').first();
        const { known, pending, ...state } = JSON.parse(row.state);
        return Response.json({ enabled: settings.enabled, ...state, pending: pending?.length || 0 });
      }
      if (request.method === 'POST' && path === '/test') {
        await sendDiscord(env, { kind: 'TEST', title: 'Notifications are working - this is not a real drop', available: true, url: 'https://geekhaven.pt/collections/pokemon' });
        return Response.json({ status: 'test sent' });
      }
      if (request.method === 'POST' && path === '/check') return Response.json(await runCheck(env));
      return new Response('Not found', { status: 404 });
    } catch { return Response.json({ error: 'Operation failed. Check database bindings and secrets.' }, { status: 500 }); }
  }
};
