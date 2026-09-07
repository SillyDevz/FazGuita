import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { getSources, handleLinksInteraction } from '../src/discord-links.js';
import { linksCommand, registrationRequest, main } from '../scripts/register-commands.mjs';

const APP = '123456789012345678';
const GUILD = '987654321098765432';
const DEFAULTS = ['https://geekhaven.pt/collections/pokemon'];

function bytesToHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function makeKeys() {
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKey = bytesToHex(new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey)));
  return { keyPair, publicKey };
}

async function signedRequest(privateKey, body, { timestamp = String(Math.floor(Date.now() / 1000)), path = '/interactions', mutateBody } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const sig = bytesToHex(new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(timestamp + raw))));
  const sendBody = mutateBody ? mutateBody(raw) : raw;
  return new Request(`https://example.test${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Signature-Ed25519': sig,
      'X-Signature-Timestamp': timestamp
    },
    body: sendBody
  });
}

function setup(publicKey) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const DB = { prepare(query) {
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async run() { return { meta: { changes: sql.prepare(query).run(...args).changes } }; },
      async first() { return sql.prepare(query).get(...args) ?? null; }
    };
  }};
  const env = {
    DB,
    DISCORD_PUBLIC_KEY: publicKey,
    DISCORD_APPLICATION_ID: APP,
    DISCORD_GUILD_ID: GUILD
  };
  const monitorState = () => sql.prepare('SELECT state, lease_until, lease_token FROM monitor WHERE id = 1').get();
  return { sql, env, monitorState };
}

function validateSource(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('bad');
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/products\.json$/, '').replace(/\/$/, '');
  return parsed.href;
}

function interaction(overrides = {}) {
  return {
    type: 2,
    application_id: APP,
    guild_id: GUILD,
    member: { permissions: '32' },
    data: { name: 'links', options: [{ name: 'listar', type: 1 }] },
    ...overrides
  };
}

function linksData(name, url) {
  if (name === 'listar') return { name: 'links', options: [{ name: 'listar', type: 1 }] };
  return { name: 'links', options: [{ name: name, type: 1, options: [{ name: 'url', type: 3, value: url }] }] };
}

async function json(response) {
  return { status: response.status, body: await response.json() };
}

test('registration command definition snowflakes dry-run and apply errors', async () => {
  assert.equal(linksCommand.name, 'links');
  assert.equal(linksCommand.type, 1);
  assert.equal(linksCommand.default_member_permissions, '32');
  assert.deepEqual(linksCommand.options.map(o => o.name), ['adicionar', 'listar', 'remover']);

  const req = registrationRequest({ DISCORD_APPLICATION_ID: APP, DISCORD_GUILD_ID: GUILD });
  assert.equal(req.method, 'POST');
  assert.equal(req.url, `https://discord.com/api/v10/applications/${APP}/guilds/${GUILD}/commands`);
  assert.equal(req.body, linksCommand);

  assert.throws(() => registrationRequest({ DISCORD_APPLICATION_ID: 'app-x', DISCORD_GUILD_ID: GUILD }), /Invalid DISCORD_APPLICATION_ID/);
  assert.throws(() => registrationRequest({ DISCORD_APPLICATION_ID: APP, DISCORD_GUILD_ID: 'guild-x' }), /Invalid DISCORD_GUILD_ID/);
  assert.throws(() => registrationRequest({ DISCORD_APPLICATION_ID: APP, DISCORD_GUILD_ID: GUILD }, { requireBotToken: true }), /Missing DISCORD_BOT_TOKEN/);

  const logs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => logs.push(['log', ...args]);
  console.error = (...args) => logs.push(['err', ...args]);
  try {
    await main([], { DISCORD_APPLICATION_ID: APP, DISCORD_GUILD_ID: GUILD });
    assert.ok(logs.some(([kind, msg]) => kind === 'log' && String(msg).includes('"dryRun": true')));

    process.exitCode = 0;
    await main(['--apply'], { DISCORD_APPLICATION_ID: APP, DISCORD_GUILD_ID: GUILD, DISCORD_BOT_TOKEN: 'tok' }, async () => { throw new Error('network'); });
    assert.equal(process.exitCode, 1);
    assert.ok(logs.some(([kind, msg]) => kind === 'err' && msg === 'Discord command registration failed'));
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exitCode = 0;
  }
});

test('valid ping and signature failures', async () => {
  const { keyPair, publicKey } = await makeKeys();
  const x = setup(publicKey);
  try {
    const ping = await handleLinksInteraction(await signedRequest(keyPair.privateKey, { type: 1 }), x.env, DEFAULTS, validateSource);
    assert.deepEqual(await ping.json(), { type: 1 });

    assert.equal((await handleLinksInteraction(new Request('https://example.test/interactions', { method: 'POST', body: '{"type":1}' }), x.env, DEFAULTS, validateSource)).status, 401);

    const badSig = await signedRequest(keyPair.privateKey, { type: 1 });
    badSig.headers.set('X-Signature-Ed25519', '00'.repeat(64));
    assert.equal((await handleLinksInteraction(badSig, x.env, DEFAULTS, validateSource)).status, 401);

    const expired = await signedRequest(keyPair.privateKey, { type: 1 }, { timestamp: String(Math.floor(Date.now() / 1000) - 301) });
    assert.equal((await handleLinksInteraction(expired, x.env, DEFAULTS, validateSource)).status, 401);

    const tampered = await signedRequest(keyPair.privateKey, { type: 1 }, { mutateBody: raw => raw.replace('1', '2') });
    assert.equal((await handleLinksInteraction(tampered, x.env, DEFAULTS, validateSource)).status, 401);
  } finally { x.sql.close(); }
});

test('guild application DM and permission gates do not mutate', async () => {
  const { keyPair, publicKey } = await makeKeys();
  const x = setup(publicKey);
  try {
    const before = x.monitorState();
    assert.deepEqual(await getSources(x.env, DEFAULTS), DEFAULTS);
    const add = linksData('adicionar', 'https://shop.test/collections/cards');

    const cases = [
      [{ application_id: '999' }, /Comando indisponível/],
      [{ guild_id: '111' }, /Comando indisponível/],
      [{ guild_id: undefined }, /Comando indisponível/],
      [{ member: { permissions: '0' } }, /Sem permissão para gerir fontes/],
      [{ member: { permissions: 'not-a-number' } }, /Sem permissão para gerir fontes/],
      [{ member: undefined }, /Sem permissão para gerir fontes/]
    ];

    for (const [overrides, pattern] of cases) {
      const res = await json(await handleLinksInteraction(
        await signedRequest(keyPair.privateKey, interaction({ ...overrides, data: add })),
        x.env, DEFAULTS, validateSource
      ));
      assert.equal(res.status, 200);
      assert.equal(res.body.type, 4);
      assert.equal(res.body.data.flags, 64);
      assert.deepEqual(res.body.data.allowed_mentions, { parse: [] });
      assert.match(res.body.data.content, pattern);
      assert.deepEqual(await getSources(x.env, DEFAULTS), DEFAULTS);
      assert.equal(x.sql.prepare('SELECT COUNT(*) AS n FROM source_config').get().n, 0);
    }

    for (const missing of ['DISCORD_APPLICATION_ID', 'DISCORD_GUILD_ID']) {
      const env = { ...x.env, [missing]: undefined };
      const res = await json(await handleLinksInteraction(
        await signedRequest(keyPair.privateKey, interaction({ data: add })),
        env, DEFAULTS, validateSource
      ));
      assert.match(res.body.data.content, /Não foi possível processar o pedido/);
      assert.equal(x.sql.prepare('SELECT COUNT(*) AS n FROM source_config').get().n, 0);
    }

    assert.deepEqual(x.monitorState(), before);
  } finally { x.sql.close(); }
});

test('admin and manage guild can add list remove including last; defaults stay removed', async () => {
  const { keyPair, publicKey } = await makeKeys();
  const x = setup(publicKey);
  try {
    const monitorBefore = x.monitorState();
    const other = 'https://shop.test/collections/cards';

    for (const permissions of ['8', '32', String(8n | 32n)]) {
      const list = await json(await handleLinksInteraction(
        await signedRequest(keyPair.privateKey, interaction({ member: { permissions }, data: linksData('listar') })),
        x.env, DEFAULTS, validateSource
      ));
      assert.match(list.body.data.content, /geekhaven\.pt\/collections\/pokemon/);
    }

    let res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({ data: linksData('adicionar', other + '/products.json?x=1') })),
      x.env, DEFAULTS, validateSource
    ));
    assert.match(res.body.data.content, /Fonte adicionada/);
    assert.deepEqual(await getSources(x.env, DEFAULTS), [...DEFAULTS, other]);

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({ data: linksData('adicionar', other) })),
      x.env, DEFAULTS, validateSource
    ));
    assert.match(res.body.data.content, /já estava na lista/);
    assert.deepEqual(await getSources(x.env, DEFAULTS), [...DEFAULTS, other]);

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({ data: linksData('remover', DEFAULTS[0]) })),
      x.env, DEFAULTS, validateSource
    ));
    assert.match(res.body.data.content, /Fonte removida/);
    assert.deepEqual(await getSources(x.env, DEFAULTS), [other]);

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({ data: linksData('remover', other) })),
      x.env, DEFAULTS, validateSource
    ));
    assert.match(res.body.data.content, /Fonte removida/);
    assert.deepEqual(await getSources(x.env, DEFAULTS), []);

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({ data: linksData('listar') })),
      x.env, DEFAULTS, validateSource
    ));
    assert.match(res.body.data.content, /Nenhuma fonte configurada/);
    assert.ok(!res.body.data.content.includes(DEFAULTS[0]));

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({ data: linksData('remover', other) })),
      x.env, DEFAULTS, validateSource
    ));
    assert.match(res.body.data.content, /não estava na lista/);

    assert.deepEqual(x.monitorState(), monitorBefore);
  } finally { x.sql.close(); }
});

test('malformed URL options long list and max sources', async () => {
  const { keyPair, publicKey } = await makeKeys();
  const x = setup(publicKey);
  try {
    let res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({ data: linksData('adicionar', 'http://insecure.test/collections/x') })),
      x.env, DEFAULTS, validateSource
    ));
    assert.match(res.body.data.content, /URL inválida/);

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({ data: { name: 'links', options: [{ name: 'adicionar', type: 1 }] } })),
      x.env, DEFAULTS, validateSource
    ));
    assert.match(res.body.data.content, /Não foi possível processar/);

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({ data: { name: 'links', options: [{ name: 'adicionar', type: 1, options: [{ name: 'url', type: 3, value: 1 }] }] } })),
      x.env, DEFAULTS, validateSource
    ));
    assert.match(res.body.data.content, /Não foi possível processar/);

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({ data: { name: 'other', options: [{ name: 'listar', type: 1 }] } })),
      x.env, DEFAULTS, validateSource
    ));
    assert.match(res.body.data.content, /Não foi possível processar/);

    const many = Array.from({ length: 20 }, (_, i) => `https://shop${i}.test/collections/cards`);
    x.sql.prepare('INSERT INTO source_config (id, sources, version) VALUES (1, ?, 0)').run(JSON.stringify(many));
    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({ data: linksData('adicionar', 'https://extra.test/collections/cards') })),
      x.env, DEFAULTS, validateSource
    ));
    assert.match(res.body.data.content, /Limite de 20/);
    assert.equal((await getSources(x.env, DEFAULTS)).length, 20);

    const long = Array.from({ length: 20 }, (_, i) => `https://very-long-shop-name-${'x'.repeat(60)}-${i}.example.test/collections/pokemon-trading-card-game`);
    x.sql.prepare('UPDATE source_config SET sources = ?, version = 1 WHERE id = 1').run(JSON.stringify(long));
    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({ data: linksData('listar') })),
      x.env, DEFAULTS, validateSource
    ));
    assert.ok(res.body.data.content.length <= 2000);
    assert.match(res.body.data.content, /e mais \d+/);
  } finally { x.sql.close(); }
});

test('concurrent adds CAS keeps all updates', async () => {
  const { keyPair, publicKey } = await makeKeys();
  const x = setup(publicKey);
  try {
    const urls = Array.from({ length: 5 }, (_, i) => `https://shop${i}.test/collections/cards`);
    await Promise.all(urls.map(async url => {
      const res = await handleLinksInteraction(
        await signedRequest(keyPair.privateKey, interaction({ data: linksData('adicionar', url) })),
        x.env, DEFAULTS, validateSource
      );
      assert.equal(res.status, 200);
    }));
    const sources = await getSources(x.env, DEFAULTS);
    for (const url of urls) assert.ok(sources.includes(url));
    assert.ok(sources.includes(DEFAULTS[0]));
    assert.equal(sources.length, DEFAULTS.length + urls.length);
  } finally { x.sql.close(); }
});
