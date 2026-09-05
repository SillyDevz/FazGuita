import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { runCheck, changesFor, retrySeconds } from '../src/worker.js';
const config = { enabled: true, alertOnNewProducts: true, alertOnRestocks: true, alertOnSoldOutListings: true, includeKeywords: [], excludeKeywords: [] };
function setup() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const DB = { prepare(query) {
    let args = [];
    return { bind(...values) { args = values; return this; },
      async run() { return { meta: { changes: sql.prepare(query).run(...args).changes } }; },
      async first() { return sql.prepare(query).get(...args); }
    };
  }};
  const state = () => JSON.parse(sql.prepare('SELECT state FROM monitor').get().state);
  const due = () => { const s = state(); s.nextCheck = 0; sql.prepare('UPDATE monitor SET state = ?').run(JSON.stringify(s)); };
  return { sql, state, due, env: { DB, DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/fake', ADMIN_TOKEN: 'test' } };
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
    const known = x.state().known;
    const result = await runCheck(x.env, config, async () => new Response('', { status: 429, headers: { 'Retry-After': '1800' } }));
    assert.equal(result.status, 'error'); assert.deepEqual(x.state().known, known);
    assert.ok(x.state().nextCheck > Date.now() + 1790000);
    x.due(); assert.equal((await runCheck(x.env, config, async () => new Response('', { status: 403 }))).status, 'blocked');
    x.due(); assert.equal((await runCheck(x.env, config, () => { throw Error('should not fetch'); })).status, 'blocked');
    assert.equal((await runCheck(x.env, { ...config, enabled: false })).status, 'paused');
    assert.equal((await worker.fetch(new Request('https://example.test/check', { method: 'POST' }), x.env)).status, 401);
  } finally { x.sql.close(); }
});
test('event filters and retry delay', () => {
  const products = [product(1,false), product(2,true)];
  assert.equal(changesFor(products, {}, { ...config, alertOnSoldOutListings: false }).length, 1);
  assert.equal(changesFor(products, {}, { ...config, includeKeywords: ['BOOSTER'], excludeKeywords: ['2'] }).length, 1);
  assert.equal(changesFor(products, {}, { ...config, alertOnNewProducts: false }).length, 0);
  assert.equal(retrySeconds('1800',1), 1800);
});
