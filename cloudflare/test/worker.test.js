import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, {
  runCheck, configuredCheck, changesFor, retrySeconds, sourcesFor, shopifyProducts, continenteProduct, continenteSearchPage,
  sendDiscord, testSourceUrl, sendTestNotification, getMonitorStatus
} from '../src/worker.js';
const config = { enabled: true, alertOnNewProducts: true, alertOnRestocks: true, alertOnSoldOutListings: true, includeKeywords: [], excludeKeywords: [] };
const bundled = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
function setup() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const DB = { prepare(query) {
    let args = [];
    return { bind(...values) { args = values; return this; },
      async run() { return { meta: { changes: sql.prepare(query).run(...args).changes } }; },
      async first() { return sql.prepare(query).get(...args) ?? null; }
    };
  }};
  const state = () => JSON.parse(sql.prepare('SELECT state FROM monitor').get().state);
  const due = () => { const s = state(); s.nextCheck = 0; for (const source of Object.values(s.sources || {})) source.nextCheck = 0; sql.prepare('UPDATE monitor SET state = ?').run(JSON.stringify(s)); };
  const persistSources = sources => sql.prepare('INSERT INTO source_config (id, sources, version) VALUES (1, ?, 0) ON CONFLICT(id) DO UPDATE SET sources = excluded.sources, version = source_config.version + 1').run(JSON.stringify(sources));
  return { sql, state, due, persistSources, env: { DB, DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/fake', ADMIN_TOKEN: 'test', DISCORD_PUBLIC_KEY: '00', DISCORD_APPLICATION_ID: 'app', DISCORD_GUILD_ID: 'guild' } };
}
const product = (id, available) => ({ id, title: `Booster ${id}`, handle: `booster-${id}`, variants: [{ available }] });
test('baseline, new product, restock, persisted duplicate suppression and webhook retry', async () => {
  const x = setup();
  try {
    let products = [product(1, false)], posts = [], fail = false;
    const fakeFetch = async (url, options) => {
      if (String(url).startsWith('https://discord.com/')) {
        if (fail) return Response.json({ retry_after: 180 }, { status: 429 });
        posts.push(JSON.parse(options.body));
        return Response.json({ id: 'message' });
      }
      return Response.json({ products });
    };
    assert.equal((await runCheck(x.env, config, fakeFetch)).sent, 0);
    x.due(); products = [product(1, true), product(2, true)];
    assert.equal((await runCheck(x.env, config, fakeFetch)).sent, 2);
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[0].allowed_mentions, { parse: [] });
    x.due(); assert.equal((await runCheck(x.env, config, fakeFetch)).sent, 0);
    x.due(); products.push(product(3, true)); fail = true;
    assert.equal((await runCheck(x.env, config, fakeFetch)).status, 'error');
    assert.equal(x.state().pending.length, 1);
    assert.ok(x.state().nextCheck > Date.now() + 170000);
    x.due(); fail = false;
    assert.equal((await runCheck(x.env, config, fakeFetch)).sent, 1);
    assert.equal(x.state().pending.length, 0);
  } finally { x.sql.close(); }
});
test('throttling and denial preserve history; pause and auth prevent work', async () => {
  const x = setup();
  try {
    const baseline = async () => Response.json({ products: [product(1,true)] });
    await runCheck(x.env, config, baseline); x.due();
    const known = x.state().sources['https://geekhaven.pt/collections/pokemon'].known;
    const result = await runCheck(x.env, config, async () => new Response('', { status: 429, headers: { 'Retry-After': '1800' } }));
    assert.equal(result.status, 'error'); assert.deepEqual(x.state().sources['https://geekhaven.pt/collections/pokemon'].known, known);
    assert.ok(x.state().sources['https://geekhaven.pt/collections/pokemon'].nextCheck > Date.now() + 1790000);
    x.due(); assert.equal((await runCheck(x.env, config, async () => new Response('', { status: 403 }))).status, 'blocked');
    x.due(); assert.equal((await runCheck(x.env, config, () => { throw Error('should not fetch'); })).status, 'blocked');
    assert.equal((await runCheck(x.env, { ...config, enabled: false })).status, 'paused');
    assert.equal((await worker.fetch(new Request('https://example.test/check', { method: 'POST' }), x.env)).status, 401);
  } finally { x.sql.close(); }
});
test('event filters and retry delay', () => {
  const products = shopifyProducts([product(1,false), product(2,true)], sourcesFor()[0]);
  assert.equal(changesFor(products, {}, { ...config, alertOnSoldOutListings: false }).length, 1);
  assert.equal(changesFor(products, {}, { ...config, includeKeywords: ['BOOSTER'], excludeKeywords: ['2'] }).length, 1);
  assert.equal(changesFor(products, {}, { ...config, alertOnNewProducts: false }).length, 0);
  assert.equal(retrySeconds('1800',1), 1800);
});

const continentURL = 'https://www.continente.pt/produto/pokemon---cartas-tcg-mega-brave----versao-japonesa-8883406.html';
const continentSource = sourcesFor([continentURL])[0];
const ldProduct = (availability = 'InStock', sku = '8883406') => ({ '@type': 'Product', sku, name: 'Pokémon Mega Brave', offers: { '@type': 'Offer', availability: `https://schema.org/${availability}` } });
const htmlFor = data => `<html><script type="application/ld+json">${JSON.stringify(data)}</script></html>`;
test('source validation and canonical duplicates', () => {
  assert.equal(sourcesFor(['https://shop.test/collections/cards/products.json?x=1#x'])[0].url, 'https://shop.test/collections/cards');
  assert.equal(sourcesFor(['https://shop.test/products/card.json'])[0].url, 'https://shop.test/products/card');
  assert.equal(sourcesFor(['https://continente.pt/produto/card-8883406.html'])[0].url, 'https://www.continente.pt/produto/card-8883406.html');
  for (const sources of [[], ['http://shop.test/products/card'], ['https://user:pass@shop.test/products/card'], ['https://shop.test/search'], ['https://www.continente.pt/collections/pokemon'], ['https://shop.test/products/card', 'https://shop.test/products/card.json?x=2']]) assert.throws(() => sourcesFor(sources));
});
test('Continente target JSON-LD, exact stock, conflicting offers, and scoped sold-out button', () => {
  assert.equal(continenteProduct(htmlFor({ '@graph': [ldProduct('OutOfStock', 'other'), ldProduct()] }), continentSource)[0].available, true);
  for (const availability of ['OutOfStock', 'SoldOut', 'Discontinued']) assert.equal(continenteProduct(htmlFor([ldProduct(availability)]), continentSource)[0].available, false);
  for (const data of [ldProduct('PreOrder'), ldProduct('InStock', 'other'), [ldProduct(), ldProduct()], { ...ldProduct(), offers: [{ availability: 'https://schema.org/InStock' }, { availability: 'https://schema.org/OutOfStock' }] }, { ...ldProduct(), name: '' }, { ...ldProduct(), offers: {} }]) assert.throws(() => continenteProduct(htmlFor(data), continentSource));
  const button = (sku, stock) => `<button class="add-to-cart" data-container="pdp" data-pid="${sku}" data-outofstock="${stock}">Carrinho</button>`;
  assert.equal(continenteProduct(htmlFor(ldProduct()) + button('8883406', 'true'), continentSource)[0].available, false);
  assert.equal(continenteProduct(htmlFor(ldProduct()) + button('other', 'true'), continentSource)[0].available, true);
  assert.throws(() => continenteProduct(htmlFor(ldProduct()) + button('8883406', 'unknown'), continentSource));
  assert.throws(() => continenteProduct('<script type="application/ld+json">broken</script>', continentSource));
});
test('multi-source baselines, isolated denial and restock, defaults and unknown stock preserve history', async () => {
  const x = setup();
  try {
    let available = false, denied = false, malformed = false, posts = [];
    const cfg = { ...config, alertOnSoldOutListings: undefined, sources: ['https://shop.test/collections/cards', continentURL] };
    delete cfg.alertOnSoldOutListings;
    const fakeFetch = async (url, options) => {
      if (String(url).startsWith('https://discord.com')) { posts.push(JSON.parse(options.body)); return Response.json({}); }
      if (String(url).startsWith('https://shop.test')) return denied ? new Response('', { status: 403 }) : Response.json({ products: [product(1, false)] });
      return new Response(htmlFor(ldProduct(malformed ? 'PreOrder' : available ? 'InStock' : 'OutOfStock')));
    };
    assert.equal((await runCheck(x.env, cfg, fakeFetch)).sent, 0);
    x.due(); denied = true; malformed = true;
    assert.equal((await runCheck(x.env, cfg, fakeFetch)).status, 'error');
    assert.equal(x.state().sources[continentURL].known['https://www.continente.pt:8883406'].available, false);
    x.due(); malformed = false; available = true;
    assert.equal((await runCheck(x.env, cfg, fakeFetch)).sent, 1);
    assert.equal(posts[0].embeds[0].url, continentURL);
    x.due(); assert.equal((await runCheck(x.env, cfg, fakeFetch)).sent, 0);
  } finally { x.sql.close(); }
});
test('legacy history migration and dynamic added source are silent', async () => {
  const x = setup();
  try {
    x.sql.prepare('UPDATE monitor SET state = ?').run(JSON.stringify({ initialized: true, known: { '1': { available: false } }, pending: [] }));
    let posts = 0;
    const fakeFetch = async url => {
      if (String(url).startsWith('https://discord.com')) { posts++; return Response.json({}); }
      if (String(url).startsWith('https://www.continente')) return new Response(htmlFor(ldProduct()));
      return Response.json({ products: [product(1, true)] });
    };
    assert.equal((await runCheck(x.env, config, fakeFetch)).sent, 1);
    assert.equal(x.state().sources['https://geekhaven.pt/collections/pokemon'].known['https://geekhaven.pt:1'].available, true);
    x.due();
    assert.equal((await runCheck(x.env, { ...config, sources: ['https://geekhaven.pt/collections/pokemon', continentURL] }, fakeFetch)).sent, 0);
    assert.equal(x.state().sources[continentURL].initialized, true);
    assert.equal(posts, 1);
  } finally { x.sql.close(); }
});
test('Shopify unknown availability and malformed feeds never become sold-out history', async () => {
  const source = sourcesFor()[0];
  for (const variants of [[], [{}], [{ available: 'true' }], [{ available: true }, {}]]) assert.throws(() => shopifyProducts([{ ...product(1,true), variants }], source));
  assert.throws(() => shopifyProducts({}, source));
  const x = setup();
  try {
    let products = [product(1, true)];
    const fetcher = async () => Response.json({ products });
    await runCheck(x.env, config, fetcher); x.due();
    products = [product(1, undefined)];
    assert.equal((await runCheck(x.env, config, fetcher)).status, 'error');
    assert.equal(x.state().sources[source.url].known['https://geekhaven.pt:1'].available, true);
    x.due(); products = [product(1, true)];
    assert.equal((await runCheck(x.env, config, fetcher)).sent, 0);
  } finally { x.sql.close(); }
});

const searchURL = 'https://www.continente.pt/pesquisa/?utm_source=x&srule=Continente&q=%20pokemon%20tcg%20&pmin=0.01&start=0&sz=35&fbclid=1#frag';
const searchCanonical = 'https://www.continente.pt/pesquisa/?pmin=0.01&q=pokemon+tcg&srule=Continente&start=0&sz=35';
const ragingURL = 'https://www.continente.pt/produto/pokemon---cartas-tcg-raging-surf-pack---versao-japonesa-8883689.html';
const ragingSource = { url: ragingURL, origin: 'https://www.continente.pt', type: 'continente' };
const detail = (pid, flag, extraClass = '') => `<div class="row no-gutters product-detail col-product-detail product-wrapper${flag === 'true' ? ' product-out-of-stock' : ''}${extraClass}" ${flag == null ? '' : `data-is-product-out-of-stock="${flag}" `}data-pid="${pid}">`;
const pdpButton = (pid, stock) => `<button class="add-to-cart" data-container="pdp" data-pid="${pid}" data-outofstock="${stock}">Carrinho</button>`;
const tile = (sku, slug = `item-${sku}`) => `<div class="product" data-pid="${sku}"><div class="product-tile"><a href="https://www.continente.pt/produto/${slug}-${sku}.html">x</a><a href="/produto/${slug}-${sku}.html?showNote=true">note</a></div></div>`;
const footer = (total, size, page) => `<div class="col-12 grid-footer" data-page-size="${size}" data-page-number="${page}" data-total-count="${total}"></div>`;
const searchHtml = (tiles, total = tiles.length, size = 35, page = 0) => `<html>${tiles.map(([sku, slug]) => tile(sku, slug)).join('')}${footer(total, size, page)}</html>`;
const pdpHtml = (availability, sku, options = {}) => {
  const data = ldProduct(availability, sku);
  data.name = options.name || data.name;
  return htmlFor(data) + (options.detail || '') + (options.button || '');
};

test('Continente search URL canonicalization and validation', () => {
  const source = sourcesFor([searchURL])[0];
  assert.equal(source.url, searchCanonical);
  assert.equal(source.type, 'continente-search');
  assert.equal(new URL(source.url).pathname, '/pesquisa/');
  assert.equal(sourcesFor(['https://continente.pt/pesquisa?q=cards'])[0].url, 'https://www.continente.pt/pesquisa/?q=cards');
  assert.throws(() => sourcesFor(['https://www.continente.pt/pesquisa']));
  assert.throws(() => sourcesFor(['https://www.continente.pt/pesquisa?q=%20%20']));
  assert.throws(() => sourcesFor(['https://www.continente.pt/pesquisa?q=cards&q=toys']));
  assert.throws(() => sourcesFor(['https://www.continente.pt/pesquisa?q=cards&start=-1']));
  assert.throws(() => sourcesFor(['https://www.continente.pt/pesquisa?q=cards&sz=0']));
  assert.throws(() => sourcesFor(['https://www.continente.pt/pesquisa?q=cards&sz=1.5']));
});

test('product-detail sold-out override beats JSON-LD and button positives', () => {
  const contradictory = htmlFor(ldProduct('InStock', '8883689'))
    + detail('9999999', 'false')
    + detail('8883689', 'true')
    + pdpButton('8883689', 'false');
  assert.equal(continenteProduct(contradictory, ragingSource)[0].available, false);
  assert.equal(continenteProduct(htmlFor(ldProduct('OutOfStock', '8883689')) + detail('8883689', 'false'), ragingSource)[0].available, false);
  assert.equal(continenteProduct(htmlFor(ldProduct('InStock', '8883689')) + detail('9999999', 'true') + pdpButton('8883689', 'false'), ragingSource)[0].available, true);
  assert.equal(continenteProduct(htmlFor(ldProduct('InStock', '8883689')) + detail('8883689', 'false', ' product-out-of-stock') + pdpButton('8883689', 'false'), ragingSource)[0].available, false);
  assert.equal(continenteProduct(htmlFor(ldProduct('InStock', '8883689')) + detail('8883689', null, ' product-out-of-stock') + pdpButton('8883689', 'false'), ragingSource)[0].available, false);
  assert.throws(() => continenteProduct(htmlFor(ldProduct('InStock', '8883689')) + detail('8883689', 'maybe'), ragingSource));
});

test('Continente search discovery, empty footer, malformed pages and limits', () => {
  const origin = 'https://www.continente.pt';
  const page = continenteSearchPage(searchHtml([['8883689', 'raging'], ['8883406', 'brave'], ['8883689', 'dup']], 14, '35.0', 0), origin);
  assert.deepEqual(page.links, [
    'https://www.continente.pt/produto/raging-8883689.html',
    'https://www.continente.pt/produto/brave-8883406.html'
  ]);
  assert.equal(page.totalCount, 14);
  assert.equal(page.pageSize, 35);
  assert.equal(page.pageNumber, 0);
  assert.deepEqual(continenteSearchPage(`<html>${footer(0, 35, 0)}</html>`, origin), { links: [], totalCount: 0, pageSize: 35, pageNumber: 0 });
  assert.throws(() => continenteSearchPage('<html><div class="product" data-pid="1"></div></html>', origin));
  assert.throws(() => continenteSearchPage(`<html>${footer('x', 35, 0)}</html>`, origin));
  assert.throws(() => continenteSearchPage(`<html><div class="product" data-pid="1"><a href="https://www.continente.pt/categoria/x">x</a></div>${footer(1, 35, 0)}</html>`, origin));
});

test('Continente search baseline sold-out, restock, listing etag ignored, failed PDP preserves history', async () => {
  const x = setup();
  try {
    const cfg = { ...config, sources: [searchCanonical] };
    let available = false, failPdp = false, posts = [], pdpFetches = 0, searchHeaders = [], searchUrls = [];
    const listing = searchHtml([['8883689', 'raging']], 1, 35, 0);
    const fakeFetch = async (url, options = {}) => {
      if (String(url).startsWith('https://discord.com')) { posts.push(JSON.parse(options.body)); return Response.json({}); }
      if (String(url).includes('/pesquisa')) {
        searchUrls.push(String(url));
        searchHeaders.push(options.headers || {});
        assert.equal(new URL(url).pathname, '/pesquisa/');
        return new Response(listing, { headers: { ETag: '"search-v1"' } });
      }
      pdpFetches++;
      if (failPdp) return new Response(htmlFor(ldProduct('PreOrder', '8883689')));
      return new Response(pdpHtml(available ? 'InStock' : 'OutOfStock', '8883689', {
        name: 'Pokémon Raging Surf',
        detail: detail('8883689', available ? 'false' : 'true'),
        button: pdpButton('8883689', 'false')
      }));
    };
    assert.equal((await runCheck(x.env, cfg, fakeFetch)).sent, 0);
    assert.equal(x.state().sources[searchCanonical].known['https://www.continente.pt:8883689'].available, false);
    assert.equal(x.state().sources[searchCanonical].etag, null);
    assert.equal(searchHeaders.every(h => !('If-None-Match' in h)), true);
    assert.ok(searchUrls.every(u => new URL(u).pathname === '/pesquisa/'));
    const baselinePdps = pdpFetches;
    x.due(); available = true;
    assert.equal((await runCheck(x.env, cfg, fakeFetch)).sent, 1);
    assert.equal(posts[0].embeds[0].url, 'https://www.continente.pt/produto/raging-8883689.html');
    assert.ok(pdpFetches > baselinePdps);
    assert.equal(searchHeaders.every(h => !('If-None-Match' in h)), true);
    x.due(); assert.equal((await runCheck(x.env, cfg, fakeFetch)).sent, 0);
    const known = x.state().sources[searchCanonical].known;
    x.due(); failPdp = true;
    assert.equal((await runCheck(x.env, cfg, fakeFetch)).status, 'error');
    assert.deepEqual(x.state().sources[searchCanonical].known, known);
    assert.equal(x.state().pending.length, 0);
    assert.equal(posts.length, 1);
  } finally { x.sql.close(); }
});

test('Continente search pagination, completeness and hard limits fail closed', async () => {
  const x = setup();
  try {
    const searchPaginated = 'https://www.continente.pt/pesquisa/?q=pokemon&sz=2';
    const cfg = { ...config, sources: [searchPaginated] };
    const pages = {
      0: searchHtml([['1', 'a'], ['2', 'b']], 4, 2, 0),
      2: searchHtml([['3', 'c'], ['4', 'd']], 4, 2, 1)
    };
    const fakeFetch = async (url, options = {}) => {
      if (String(url).startsWith('https://discord.com')) return Response.json({});
      if (String(url).includes('/pesquisa')) {
        assert.equal(new URL(url).pathname, '/pesquisa/');
        const start = new URL(url).searchParams.get('start') || '0';
        assert.equal(new URL(url).searchParams.get('q'), 'pokemon');
        assert.equal(new URL(url).searchParams.get('sz'), '2');
        return new Response(pages[start]);
      }
      const sku = String(url).match(/-(\d+)\.html$/)[1];
      return new Response(pdpHtml('OutOfStock', sku, { name: `Item ${sku}`, detail: detail(sku, 'true') }));
    };
    assert.equal((await runCheck(x.env, cfg, fakeFetch)).sent, 0);
    assert.equal(Object.keys(x.state().sources[searchPaginated].known).length, 4);
    x.due();
    const incomplete = { ...config, sources: ['https://www.continente.pt/pesquisa/?q=gap'] };
    assert.equal((await runCheck(x.env, incomplete, async (url) => {
      if (String(url).startsWith('https://discord.com')) return Response.json({});
      return new Response(`<html>${tile('1')}<div class="product" data-pid="2"><a href="/categoria/x">x</a></div>${footer(2, 35, 0)}</html>`);
    })).status, 'error');
    assert.equal(x.state().sources[incomplete.sources[0]].lastError, 'Invalid product feed');
    assert.deepEqual(x.state().sources[incomplete.sources[0]].known, {});
    x.due();
    const over = { ...config, sources: ['https://www.continente.pt/pesquisa/?q=too-many'] };
    assert.equal((await runCheck(x.env, over, async (url) => {
      if (String(url).startsWith('https://discord.com')) return Response.json({});
      return new Response(searchHtml([['1', 'a']], 31, 35, 0));
    })).status, 'error');
    assert.equal(x.state().sources[over.sources[0]].lastError, 'Search exceeds pagination limit');
    assert.deepEqual(x.state().sources[over.sources[0]].known, {});
  } finally { x.sql.close(); }
});

test('empty sources is deliberate no_sources and drops tagged pending without store fetches', async () => {
  const x = setup();
  try {
    x.sql.prepare('UPDATE monitor SET state = ?').run(JSON.stringify({
      pending: [
        { kind: 'RESTOCK', title: 'Gone', available: true, url: 'https://shop.test/products/gone', sourceUrl: 'https://shop.test/collections/cards' },
        { kind: 'RESTOCK', title: 'Legacy', available: true, url: 'https://geekhaven.pt/products/legacy' }
      ],
      sources: { 'https://shop.test/collections/cards': { known: { 'https://shop.test:1': { available: false } }, initialized: true } }
    }));
    let fetches = 0;
    const result = await runCheck(x.env, { ...config, sources: [] }, async () => { fetches++; return new Response('no'); });
    assert.equal(result.status, 'no_sources');
    assert.equal(fetches, 0);
    assert.equal(x.state().pending.length, 1);
    assert.equal(x.state().pending[0].title, 'Legacy');
    assert.equal(x.state().sources['https://shop.test/collections/cards'].known['https://shop.test:1'].available, false);
  } finally { x.sql.close(); }
});

test('persisted source_config overrides defaults for check and status; added source baselines silently', async () => {
  const x = setup();
  try {
    const shop = 'https://shop.test/collections/cards';
    x.persistSources([shop]);
    let posts = [], fetched = [];
    const fakeFetch = async (url, options = {}) => {
      if (String(url).startsWith('https://discord.com')) { posts.push(JSON.parse(options.body)); return Response.json({}); }
      fetched.push(String(url));
      return Response.json({ products: [product(1, false)] });
    };
    assert.equal((await configuredCheck(x.env, config, fakeFetch)).sent, 0);
    assert.ok(fetched.some(u => u.startsWith('https://shop.test/')));
    assert.ok(!fetched.some(u => u.includes('geekhaven.pt')));
    assert.equal(x.state().sources[shop].known['https://shop.test:1'].available, false);
    assert.equal(x.state().sources[shop].initialized, true);
    x.due();
    fetched = [];
    assert.equal((await configuredCheck(x.env, config, fakeFetch)).sent, 0);
    const status = await worker.fetch(new Request('https://example.test/status', { headers: { Authorization: 'Bearer test' } }), x.env);
    assert.equal(status.status, 200);
    const body = await status.json();
    assert.deepEqual(body.configured, [shop]);
    assert.ok(body.sources[shop]);
    assert.equal(body.enabled, true);
    assert.equal(body.settings.enabled, true);
    x.persistSources([]);
    x.due();
    fetched = [];
    assert.equal((await configuredCheck(x.env, config, fakeFetch)).status, 'no_sources');
    assert.equal(fetched.length, 0);
    assert.equal(posts.length, 0);
  } finally { x.sql.close(); }
});

test('removing persisted default stays empty; paused check skips work but interactions stay reachable', async () => {
  const x = setup();
  try {
    const { updateMonitorSettings } = await import('../src/monitor-settings.js');
    const bundled = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
    x.persistSources([]);
    let fetches = 0;
    await updateMonitorSettings(x.env, bundled, current => ({ ...current, enabled: false }));
    assert.equal((await configuredCheck(x.env, config, async () => { fetches++; return new Response('no'); })).status, 'paused');
    assert.equal(fetches, 0);
    await updateMonitorSettings(x.env, bundled, current => ({ ...current, enabled: true }));
    assert.equal((await configuredCheck(x.env, config, async () => { fetches++; return new Response('no'); })).status, 'no_sources');
    assert.equal(fetches, 0);
    const unauthorized = await worker.fetch(new Request('https://example.test/check', { method: 'POST' }), x.env);
    assert.equal(unauthorized.status, 401);
    const interactions = await worker.fetch(new Request('https://example.test/interactions', { method: 'POST', body: '{}' }), x.env);
    assert.equal(interactions.status, 401);
    assert.notEqual(interactions.status, 404);
  } finally { x.sql.close(); }
});

test('health and configuredCheck honor runtime enabled; health stays free of user ids', async () => {
  const x = setup();
  try {
    const { updateMonitorSettings } = await import('../src/monitor-settings.js');
    const health = await worker.fetch(new Request('https://example.test/health'), x.env);
    assert.equal(health.status, 200);
    const healthy = await health.json();
    assert.equal(healthy.enabled, true);
    assert.equal(healthy.service, 'geekhaven-monitor');
    assert.equal('settings' in healthy, false);
    assert.equal(JSON.stringify(healthy).includes('207557157858574337'), false);
    await updateMonitorSettings(x.env, bundled, current => ({ ...current, enabled: false }));
    const pausedHealth = await (await worker.fetch(new Request('https://example.test/health'), x.env)).json();
    assert.equal(pausedHealth.enabled, false);
    x.persistSources(['https://shop.test/collections/cards']);
    assert.equal((await configuredCheck(x.env, config, async () => new Response('no'))).status, 'paused');
  } finally { x.sql.close(); }
});

test('runtime filters, interval and notification config apply on configuredCheck send path', async () => {
  const x = setup();
  try {
    const { updateMonitorSettings } = await import('../src/monitor-settings.js');
    x.persistSources(['https://shop.test/collections/cards']);
    let products = [product(1, false)];
    const posts = [];
    const fakeFetch = async (url, options = {}) => {
      if (String(url).startsWith('https://discord.com')) {
        assert.equal(options.redirect, 'error');
        posts.push(JSON.parse(options.body));
        return Response.json({});
      }
      return Response.json({ products });
    };
    await configuredCheck(x.env, config, fakeFetch);
    await updateMonitorSettings(x.env, bundled, current => ({
      ...current,
      includeKeywords: ['special'],
      checkIntervalSeconds: 120,
      mentionUserIds: ['207557157858574337'],
      messageTemplate: '{mencoes} {tipo} {produto}',
      webhookUsername: 'PokeBot'
    }));
    x.due();
    products = [product(1, true), { id: 2, title: 'Special Booster', handle: 'special-booster', variants: [{ available: true }] }];
    const result = await configuredCheck(x.env, config, fakeFetch);
    assert.equal(result.sent, 1);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].username, 'PokeBot');
    assert.match(posts[0].content, /<@207557157858574337>/);
    assert.match(posts[0].content, /RESTOCK|NEW PRODUCT/);
    assert.deepEqual(posts[0].allowed_mentions, {
      parse: [],
      users: ['207557157858574337'],
      roles: [],
      replied_user: false
    });
    assert.equal(posts[0].embeds[0].title.startsWith('NEW PRODUCT:') || posts[0].embeds[0].title.startsWith('RESTOCK:'), true);
    const next = x.state().sources['https://shop.test/collections/cards'].nextCheck;
    assert.ok(next > Date.now() + 100000);
  } finally { x.sql.close(); }
});

test('sendDiscord keeps TEST embed truthful and blocks everyone parsing from product text', async () => {
  const posts = [];
  const fetcher = async (url, options = {}) => {
    assert.equal(options.redirect, 'error');
    posts.push(JSON.parse(options.body));
    return Response.json({});
  };
  const notification = {
    enabled: true,
    alertOnNewProducts: true,
    alertOnRestocks: true,
    alertOnSoldOutListings: false,
    includeKeywords: [],
    excludeKeywords: [],
    checkIntervalSeconds: 60,
    mentionUserIds: ['207557157858574337'],
    messageTemplate: '{produto}',
    webhookUsername: 'PokeBot'
  };
  await sendDiscord({ DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/fake' }, {
    kind: 'TEST',
    title: 'Drop @everyone @here',
    available: true,
    url: 'https://geekhaven.pt/collections/pokemon'
  }, fetcher, notification);
  assert.match(posts[0].content, /^TEST\b/);
  assert.match(posts[0].embeds[0].title, /^TEST:/);
  assert.deepEqual(posts[0].allowed_mentions.parse, []);
  assert.deepEqual(posts[0].allowed_mentions.roles, []);
  assert.equal(posts[0].allowed_mentions.replied_user, false);
  assert.deepEqual(posts[0].allowed_mentions.users, ['207557157858574337']);
});

test('testSourceUrl is live read-only and does not mutate history while paused', async () => {
  const x = setup();
  try {
    const { updateMonitorSettings } = await import('../src/monitor-settings.js');
    await updateMonitorSettings(x.env, bundled, current => ({ ...current, enabled: false }));
    await runCheck(x.env, { ...config, enabled: false, sources: ['https://shop.test/collections/cards'] }, async () => Response.json({ products: [product(1, true)] }));
    assert.equal(x.state().sources, undefined);
    let fetches = 0;
    const result = await testSourceUrl('https://shop.test/collections/cards', async () => {
      fetches++;
      return Response.json({ products: [product(1, true), product(2, false)] });
    });
    assert.equal(fetches, 1);
    assert.equal(result.url, 'https://shop.test/collections/cards');
    assert.equal(result.products, 2);
    assert.equal(result.available, 1);
    assert.equal(result.unavailable, 1);
    assert.equal(result.unknown, 0);
    assert.equal(x.state().sources, undefined);
    await assert.rejects(() => testSourceUrl('https://evil.example/search'), /Invalid config/);
    await assert.rejects(() => testSourceUrl('http://shop.test/products/card'), /Invalid config/);
  } finally { x.sql.close(); }
});

test('admin /test uses runtime notification settings while paused and maps Discord 429', async () => {
  const x = setup();
  try {
    const { updateMonitorSettings } = await import('../src/monitor-settings.js');
    await updateMonitorSettings(x.env, bundled, current => ({
      ...current,
      enabled: false,
      messageTemplate: '{mencoes} {tipo}',
      webhookUsername: 'PokeBot'
    }));
    const posts = [];
    const prior = x.state();
    const direct = await sendTestNotification(x.env, bundled, async (_url, options = {}) => {
      posts.push(JSON.parse(options.body));
      return Response.json({});
    });
    assert.equal(direct.status, 'test sent');
    assert.match(posts[0].content, /TEST/);
    assert.match(posts[0].embeds[0].title, /^TEST:/);
    assert.equal(posts[0].username, 'PokeBot');
    assert.deepEqual(x.state(), prior);
    const status = await getMonitorStatus(x.env);
    assert.equal(status.enabled, false);
    assert.equal(status.settings.enabled, false);
    assert.ok(Array.isArray(status.configured));
    await assert.rejects(() => sendTestNotification(x.env, bundled, async () => {
      return Response.json({ retry_after: 1 }, { status: 429 });
    }), /Discord HTTP 429/);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ retry_after: 1 }, { status: 429 });
    try {
      const route429 = await worker.fetch(new Request('https://example.test/test', { method: 'POST', headers: { Authorization: 'Bearer test' } }), x.env);
      assert.equal(route429.status, 429);
      const body = await route429.json();
      assert.equal(body.error, 'Rate limited');
      assert.equal(JSON.stringify(body).includes('discord.com/api/webhooks'), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally { x.sql.close(); }
});
