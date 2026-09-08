import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { getSources, handleLinksInteraction } from '../src/discord-links.js';
import { getMonitorSettings } from '../src/monitor-settings.js';
import {
  linksCommand,
  monitorCommand,
  helpCommand,
  commands,
  registrationRequest,
  main
} from '../scripts/register-commands.mjs';

const APP = '123456789012345678';
const GUILD = '987654321098765432';
const DEFAULTS = ['https://geekhaven.pt/collections/pokemon'];
const SETTINGS_DEFAULTS = {
  enabled: false,
  alertOnNewProducts: true,
  alertOnRestocks: true,
  alertOnSoldOutListings: false,
  includeKeywords: [],
  excludeKeywords: [],
  checkIntervalSeconds: 60,
  mentionUserIds: ['207557157858574337'],
  messageTemplate: '{mencoes}',
  webhookUsername: 'PokeBot'
};
const INTERACTION_TOKEN = 'interaction.token.value_for_tests-01';

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

async function withCapturedLogs(fn) {
  const logs = [];
  const origWarn = console.warn;
  const origInfo = console.info;
  const origLog = console.log;
  const push = (level, args) => logs.push({ level, args: args.map(a => typeof a === 'string' ? a : String(a)) });
  console.warn = (...args) => push('warn', args);
  console.info = (...args) => push('info', args);
  console.log = (...args) => push('log', args);
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    console.warn = origWarn;
    console.info = origInfo;
    console.log = origLog;
  }
}

function diagRecords(logs) {
  const out = [];
  for (const entry of logs) {
    for (const arg of entry.args) {
      try {
        const parsed = JSON.parse(arg);
        if (parsed && parsed.event === 'discord_verification') out.push({ level: entry.level, ...parsed });
      } catch { /* ignore non-JSON */ }
    }
  }
  return out;
}

function assertNoSensitive(logs, forbidden) {
  const serialized = JSON.stringify(logs);
  for (const value of forbidden) {
    if (!value) continue;
    assert.equal(serialized.includes(value), false, `log leaked sensitive value`);
  }
  assert.equal(serialized.includes('SECRET_TOKEN'), false);
  assert.equal(/stack|at\s+\S+\s+\(/.test(serialized), false);
}

test('registration command definition snowflakes dry-run and apply errors', async () => {
  assert.equal(linksCommand.name, 'links');
  assert.equal(linksCommand.type, 1);
  assert.equal(linksCommand.default_member_permissions, '32');
  assert.deepEqual(linksCommand.options.map(o => o.name), ['adicionar', 'listar', 'remover', 'testar']);
  assert.equal(monitorCommand.name, 'monitor');
  assert.equal(monitorCommand.default_member_permissions, '32');
  assert.equal(helpCommand.name, 'ajuda');
  assert.equal(helpCommand.default_member_permissions, '32');
  assert.deepEqual(commands.map(c => c.name), ['links', 'monitor', 'ajuda']);
  assert.ok(monitorCommand.options.some(o => o.name === 'configurar'));
  const configurar = monitorCommand.options.find(o => o.name === 'configurar');
  assert.deepEqual(
    configurar.options.find(o => o.name === 'opcao').choices.map(c => c.value),
    [
      'alertOnNewProducts',
      'alertOnRestocks',
      'alertOnSoldOutListings',
      'includeKeywords',
      'excludeKeywords',
      'checkIntervalSeconds',
      'webhookUsername'
    ]
  );

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
    const dry = logs.find(([kind, msg]) => kind === 'log' && String(msg).includes('"dryRun": true'));
    assert.ok(dry);
    const dryPayload = JSON.parse(dry[1]);
    assert.equal(dryPayload.commands.length, 3);
    assert.deepEqual(dryPayload.commands.map(c => c.name), ['links', 'monitor', 'ajuda']);

    process.exitCode = 0;
    logs.length = 0;
    const calls = [];
    await main(['--apply'], { DISCORD_APPLICATION_ID: APP, DISCORD_GUILD_ID: GUILD, DISCORD_BOT_TOKEN: 'tok' }, async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (calls.length === 2) return { ok: false, status: 500 };
      return { ok: true, status: 200 };
    });
    assert.equal(process.exitCode, 1);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map(c => c.body.name), ['links', 'monitor', 'ajuda']);
    assert.ok(logs.some(([kind, msg]) => kind === 'log' && msg === 'Registered /links guild command'));
    assert.ok(logs.some(([kind, msg]) => kind === 'err' && msg === 'Discord command registration failed: monitor'));
    assert.ok(logs.some(([kind, msg]) => kind === 'log' && msg === 'Registered /ajuda guild command'));
    assert.equal(JSON.stringify(logs).includes('tok'), false);

    process.exitCode = 0;
    logs.length = 0;
    await main(['--apply'], { DISCORD_APPLICATION_ID: APP, DISCORD_GUILD_ID: GUILD, DISCORD_BOT_TOKEN: 'tok' }, async () => { throw new Error('network'); });
    assert.equal(process.exitCode, 1);
    assert.equal(logs.filter(([kind, msg]) => kind === 'err' && String(msg).startsWith('Discord command registration failed:')).length, 3);
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

test('verification diagnostics cover key signature timestamp and success ping', async () => {
  const { keyPair, publicKey } = await makeKeys();
  const x = setup(publicKey);
  const forbiddenBase = [publicKey, APP, GUILD, 'geekhaven.pt'];

  try {
    const missingKey = await withCapturedLogs(async () => handleLinksInteraction(
      await signedRequest(keyPair.privateKey, { type: 1 }),
      { ...x.env, DISCORD_PUBLIC_KEY: undefined }, DEFAULTS, validateSource
    ));
    assert.equal(missingKey.result.status, 401);
    let d = diagRecords(missingKey.logs);
    assert.equal(d.length, 1);
    assert.equal(d[0].level, 'warn');
    assert.equal(d[0].reason, 'public_key_missing');
    assert.equal(d[0].stage, 'public_key');
    assert.equal(d[0].http_status, 401);
    assert.equal(d[0].diagnostics_version, '1');
    assert.equal(d[0].key_present, false);
    assertNoSensitive(missingKey.logs, forbiddenBase);

    const nonString = await withCapturedLogs(async () => handleLinksInteraction(
      await signedRequest(keyPair.privateKey, { type: 1 }),
      { ...x.env, DISCORD_PUBLIC_KEY: 42 }, DEFAULTS, validateSource
    ));
    assert.equal(nonString.result.status, 401);
    d = diagRecords(nonString.logs);
    assert.equal(d[0].reason, 'public_key_type');
    assert.equal(d[0].key_type, 'number');

    const badHex = await withCapturedLogs(async () => handleLinksInteraction(
      await signedRequest(keyPair.privateKey, { type: 1 }),
      { ...x.env, DISCORD_PUBLIC_KEY: 'zz'.repeat(32) }, DEFAULTS, validateSource
    ));
    assert.equal(badHex.result.status, 401);
    d = diagRecords(badHex.logs);
    assert.equal(d[0].reason, 'public_key_invalid_hex');
    assert.equal(d[0].key_valid_hex, false);

    const shortKey = await withCapturedLogs(async () => handleLinksInteraction(
      await signedRequest(keyPair.privateKey, { type: 1 }),
      { ...x.env, DISCORD_PUBLIC_KEY: publicKey.slice(0, 62) }, DEFAULTS, validateSource
    ));
    assert.equal(shortKey.result.status, 401);
    d = diagRecords(shortKey.logs);
    assert.equal(d[0].reason, 'public_key_invalid_length');
    assert.equal(d[0].key_valid_hex, true);
    assert.equal(d[0].key_decoded_byte_count, 31);

    const quoted = await withCapturedLogs(async () => handleLinksInteraction(
      await signedRequest(keyPair.privateKey, { type: 1 }),
      { ...x.env, DISCORD_PUBLIC_KEY: `"${publicKey}"` }, DEFAULTS, validateSource
    ));
    assert.equal(quoted.result.status, 401);
    d = diagRecords(quoted.logs);
    assert.equal(d[0].reason, 'public_key_invalid_hex');
    assert.equal(d[0].key_surrounding_quotes, true);
    assert.equal(d[0].key_leading_trailing_whitespace, false);
    assertNoSensitive(quoted.logs, [publicKey, `"${publicKey}"`]);

    const spaced = await withCapturedLogs(async () => handleLinksInteraction(
      await signedRequest(keyPair.privateKey, { type: 1 }),
      { ...x.env, DISCORD_PUBLIC_KEY: ` ${publicKey} ` }, DEFAULTS, validateSource
    ));
    assert.equal(spaced.result.status, 401);
    d = diagRecords(spaced.logs);
    assert.equal(d[0].reason, 'public_key_invalid_hex');
    assert.equal(d[0].key_leading_trailing_whitespace, true);
    assert.equal(d[0].key_surrounding_quotes, false);
    assertNoSensitive(spaced.logs, [publicKey, ` ${publicKey} `]);

    const missingSig = await withCapturedLogs(() => handleLinksInteraction(
      new Request('https://example.test/interactions', {
        method: 'POST',
        headers: { 'X-Signature-Timestamp': String(Math.floor(Date.now() / 1000)) },
        body: '{"type":1}'
      }),
      x.env, DEFAULTS, validateSource
    ));
    assert.equal(missingSig.result.status, 401);
    d = diagRecords(missingSig.logs);
    assert.equal(d[0].reason, 'signature_missing');
    assert.equal(d[0].stage, 'signature');

    const malformedSig = await withCapturedLogs(() => handleLinksInteraction(
      new Request('https://example.test/interactions', {
        method: 'POST',
        headers: {
          'X-Signature-Ed25519': 'not-hex',
          'X-Signature-Timestamp': String(Math.floor(Date.now() / 1000))
        },
        body: '{"type":1}'
      }),
      x.env, DEFAULTS, validateSource
    ));
    assert.equal(malformedSig.result.status, 401);
    d = diagRecords(malformedSig.logs);
    assert.equal(d[0].reason, 'signature_invalid_hex');

    const shortSig = await withCapturedLogs(() => handleLinksInteraction(
      new Request('https://example.test/interactions', {
        method: 'POST',
        headers: {
          'X-Signature-Ed25519': 'ab'.repeat(32),
          'X-Signature-Timestamp': String(Math.floor(Date.now() / 1000))
        },
        body: '{"type":1}'
      }),
      x.env, DEFAULTS, validateSource
    ));
    assert.equal(shortSig.result.status, 401);
    d = diagRecords(shortSig.logs);
    assert.equal(d[0].reason, 'signature_invalid_length');
    assert.equal(d[0].signature_decoded_byte_count, 32);

    const missingTs = await withCapturedLogs(() => handleLinksInteraction(
      new Request('https://example.test/interactions', {
        method: 'POST',
        headers: { 'X-Signature-Ed25519': 'ab'.repeat(64) },
        body: '{"type":1}'
      }),
      x.env, DEFAULTS, validateSource
    ));
    assert.equal(missingTs.result.status, 401);
    d = diagRecords(missingTs.logs);
    assert.equal(d[0].reason, 'timestamp_missing');

    const badTs = await withCapturedLogs(() => handleLinksInteraction(
      new Request('https://example.test/interactions', {
        method: 'POST',
        headers: {
          'X-Signature-Ed25519': 'ab'.repeat(64),
          'X-Signature-Timestamp': 'not-a-number'
        },
        body: '{"type":1}'
      }),
      x.env, DEFAULTS, validateSource
    ));
    assert.equal(badTs.result.status, 401);
    d = diagRecords(badTs.logs);
    assert.equal(d[0].reason, 'timestamp_invalid_format');

    const expired = await withCapturedLogs(async () => {
      const req = await signedRequest(keyPair.privateKey, { type: 1 }, { timestamp: String(Math.floor(Date.now() / 1000) - 301) });
      return handleLinksInteraction(req, x.env, DEFAULTS, validateSource);
    });
    assert.equal(expired.result.status, 401);
    d = diagRecords(expired.logs);
    assert.equal(d[0].reason, 'timestamp_outside_window');
    assert.ok(d[0].timestamp_age_seconds >= 301);

    const future = await withCapturedLogs(async () => {
      const req = await signedRequest(keyPair.privateKey, { type: 1 }, { timestamp: String(Math.floor(Date.now() / 1000) + 301) });
      return handleLinksInteraction(req, x.env, DEFAULTS, validateSource);
    });
    assert.equal(future.result.status, 401);
    d = diagRecords(future.logs);
    assert.equal(d[0].reason, 'timestamp_outside_window');

    const mismatch = await withCapturedLogs(async () => {
      const req = await signedRequest(keyPair.privateKey, { type: 1 });
      req.headers.set('X-Signature-Ed25519', '00'.repeat(64));
      return handleLinksInteraction(req, x.env, DEFAULTS, validateSource);
    });
    assert.equal(mismatch.result.status, 401);
    d = diagRecords(mismatch.logs);
    assert.equal(d[0].reason, 'signature_mismatch');
    assert.equal(d[0].stage, 'verify');
    assert.equal(d[0].crypto_import_ok, true);
    assert.equal(d[0].crypto_verify_completed, true);
    assertNoSensitive(mismatch.logs, [publicKey, '00'.repeat(64), '{"type":1}']);

    const otherKeys = await makeKeys();
    const wrongKey = await withCapturedLogs(async () => {
      const req = await signedRequest(keyPair.privateKey, { type: 1 });
      return handleLinksInteraction(req, { ...x.env, DISCORD_PUBLIC_KEY: otherKeys.publicKey }, DEFAULTS, validateSource);
    });
    assert.equal(wrongKey.result.status, 401);
    d = diagRecords(wrongKey.logs);
    assert.equal(d[0].reason, 'signature_mismatch');
    assertNoSensitive(wrongKey.logs, [publicKey, otherKeys.publicKey]);

    const success = await withCapturedLogs(async () => {
      const req = await signedRequest(keyPair.privateKey, { type: 1 });
      return handleLinksInteraction(req, x.env, DEFAULTS, validateSource);
    });
    assert.deepEqual(await success.result.json(), { type: 1 });
    d = diagRecords(success.logs);
    assert.equal(d.length, 2);
    assert.equal(d[0].level, 'info');
    assert.equal(d[0].reason, 'signature_ok');
    assert.equal(d[0].stage, 'verify');
    assert.equal(d[0].outcome, 'success');
    assert.equal(d[0].crypto_import_ok, true);
    assert.equal(d[0].crypto_verify_completed, true);
    assert.equal(typeof d[0].body_utf8_byte_count, 'number');
    assert.equal(d[1].level, 'info');
    assert.equal(d[1].reason, 'ping_ok');
    assert.equal(d[1].stage, 'ping_response');
    assert.equal(d[1].http_status, 200);
    assert.equal(d[1].diagnostic_id, d[0].diagnostic_id);
    assertNoSensitive(success.logs, [publicKey, APP, GUILD]);
  } finally { x.sql.close(); }
});

test('crypto import verify exceptions body read and logger throw stay safe', async () => {
  const { keyPair, publicKey } = await makeKeys();
  const x = setup(publicKey);
  const origImport = crypto.subtle.importKey.bind(crypto.subtle);
  const origVerify = crypto.subtle.verify.bind(crypto.subtle);

  try {
    crypto.subtle.importKey = async () => {
      const err = new Error('SECRET_TOKEN_import_leak');
      err.name = 'DataError';
      throw err;
    };
    const importFail = await withCapturedLogs(async () => {
      const req = await signedRequest(keyPair.privateKey, { type: 1 });
      return handleLinksInteraction(req, x.env, DEFAULTS, validateSource);
    });
    assert.equal(importFail.result.status, 401);
    let d = diagRecords(importFail.logs);
    assert.equal(d[0].reason, 'public_key_import_failed');
    assert.equal(d[0].stage, 'import');
    assert.equal(d[0].error_name, 'DataError');
    assertNoSensitive(importFail.logs, [publicKey, 'SECRET_TOKEN_import_leak']);

    crypto.subtle.importKey = origImport;
    crypto.subtle.verify = async () => {
      const err = new Error('SECRET_TOKEN_verify_leak');
      err.name = 'OperationError';
      throw err;
    };
    const verifyFail = await withCapturedLogs(async () => {
      const req = await signedRequest(keyPair.privateKey, { type: 1 });
      return handleLinksInteraction(req, x.env, DEFAULTS, validateSource);
    });
    assert.equal(verifyFail.result.status, 401);
    d = diagRecords(verifyFail.logs);
    assert.equal(d[0].reason, 'signature_verify_failed');
    assert.equal(d[0].stage, 'verify');
    assert.equal(d[0].error_name, 'OperationError');
    assert.equal(d[0].crypto_import_ok, true);
    assertNoSensitive(verifyFail.logs, [publicKey, 'SECRET_TOKEN_verify_leak']);

    crypto.subtle.verify = origVerify;

    const bodyFailReq = {
      method: 'POST',
      headers: {
        get(name) {
          if (name === 'X-Signature-Ed25519') return 'ab'.repeat(64);
          if (name === 'X-Signature-Timestamp') return String(Math.floor(Date.now() / 1000));
          return null;
        }
      },
      async text() {
        const err = new Error('SECRET_TOKEN_body_leak');
        err.name = 'TypeError';
        throw err;
      }
    };
    const bodyFail = await withCapturedLogs(() => handleLinksInteraction(bodyFailReq, x.env, DEFAULTS, validateSource));
    assert.equal(bodyFail.result.status, 401);
    d = diagRecords(bodyFail.logs);
    assert.equal(d[0].reason, 'body_read_failed');
    assert.equal(d[0].stage, 'body');
    assert.equal(d[0].error_name, 'TypeError');
    assertNoSensitive(bodyFail.logs, ['SECRET_TOKEN_body_leak']);

    const unknownErrReq = {
      method: 'POST',
      headers: {
        get(name) {
          if (name === 'X-Signature-Ed25519') return 'ab'.repeat(64);
          if (name === 'X-Signature-Timestamp') return String(Math.floor(Date.now() / 1000));
          return null;
        }
      },
      async text() {
        const err = new Error('SECRET_TOKEN_custom');
        err.name = 'TotallyCustomError';
        throw err;
      }
    };
    const unknownErr = await withCapturedLogs(() => handleLinksInteraction(unknownErrReq, x.env, DEFAULTS, validateSource));
    d = diagRecords(unknownErr.logs);
    assert.equal(d[0].error_name, 'unknown');
    assertNoSensitive(unknownErr.logs, ['SECRET_TOKEN_custom', 'TotallyCustomError']);

    const origWarn = console.warn;
    const origInfo = console.info;
    console.warn = () => { throw new Error('logger boom'); };
    console.info = () => { throw new Error('logger boom'); };
    try {
      const still401 = await handleLinksInteraction(
        new Request('https://example.test/interactions', { method: 'POST', body: '{"type":1}' }),
        x.env, DEFAULTS, validateSource
      );
      assert.equal(still401.status, 401);
      const still200 = await handleLinksInteraction(
        await signedRequest(keyPair.privateKey, { type: 1 }),
        x.env, DEFAULTS, validateSource
      );
      assert.deepEqual(await still200.json(), { type: 1 });
    } finally {
      console.warn = origWarn;
      console.info = origInfo;
    }

    const invalidJson = await withCapturedLogs(async () => {
      const req = await signedRequest(keyPair.privateKey, '{not-json');
      return handleLinksInteraction(req, x.env, DEFAULTS, validateSource);
    });
    assert.equal(invalidJson.result.status, 200);
    d = diagRecords(invalidJson.logs);
    assert.equal(d[0].reason, 'signature_ok');
    assert.equal(d[1].reason, 'body_invalid_json');
    assert.equal(d[1].stage, 'parse');
    assert.equal(d[1].http_status, 200);
    assert.equal(d[1].diagnostic_id, d[0].diagnostic_id);
    assertNoSensitive(invalidJson.logs, [publicKey, '{not-json']);

    const unexpected = await withCapturedLogs(async () => {
      const req = await signedRequest(keyPair.privateKey, { type: 99 });
      return handleLinksInteraction(req, x.env, DEFAULTS, validateSource);
    });
    assert.equal(unexpected.result.status, 200);
    d = diagRecords(unexpected.logs);
    assert.equal(d[0].reason, 'signature_ok');
    assert.equal(d[1].reason, 'unexpected_interaction_type');
    assert.equal(d[1].stage, 'dispatch');
    assert.equal(d[1].http_status, 200);
    assert.equal(d[1].diagnostic_id, d[0].diagnostic_id);
    const unexpectedFields = Object.keys(d[1]).sort();
    assert.deepEqual(unexpectedFields, [
      'diagnostic_id',
      'diagnostics_version',
      'event',
      'http_status',
      'level',
      'outcome',
      'reason',
      'stage'
    ]);
    assert.equal('interaction_type' in d[1], false);
    assert.equal('body' in d[1], false);
    assert.equal('type' in d[1], false);
    assertNoSensitive(unexpected.logs, [publicKey, '"type":99', '"type": 99']);
  } finally {
    crypto.subtle.importKey = origImport;
    crypto.subtle.verify = origVerify;
    x.sql.close();
  }
});

test('signed ping succeeds when DB unavailable', async () => {
  const { keyPair, publicKey } = await makeKeys();
  const env = {
    DB: { prepare() { throw new Error('db down'); } },
    DISCORD_PUBLIC_KEY: publicKey,
    DISCORD_APPLICATION_ID: APP,
    DISCORD_GUILD_ID: GUILD
  };
  const { result, logs } = await withCapturedLogs(async () => {
    const req = await signedRequest(keyPair.privateKey, { type: 1 });
    return handleLinksInteraction(req, env, DEFAULTS, validateSource);
  });
  assert.deepEqual(await result.json(), { type: 1 });
  const d = diagRecords(logs);
  assert.equal(d[0].reason, 'signature_ok');
  assert.equal(d[1].reason, 'ping_ok');
  assert.equal(d[1].http_status, 200);
  assertNoSensitive(logs, [publicKey, 'db down']);
});

function monitorData(name, options) {
  const sub = { name, type: 1 };
  if (options) sub.options = options;
  return { name: 'monitor', options: [sub] };
}

function interactionWithToken(overrides = {}) {
  return interaction({ token: INTERACTION_TOKEN, ...overrides });
}

test('ajuda and links testar readonly with private results', async () => {
  const { keyPair, publicKey } = await makeKeys();
  const x = setup(publicKey);
  try {
    const monitorBefore = x.monitorState();
    const sourcesBefore = await getSources(x.env, DEFAULTS);

    let res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({ data: { name: 'ajuda' } })),
      x.env, DEFAULTS, validateSource, { settingsDefaults: SETTINGS_DEFAULTS }
    ));
    assert.equal(res.body.type, 4);
    assert.equal(res.body.data.flags, 64);
    assert.deepEqual(res.body.data.allowed_mentions, { parse: [] });
    assert.match(res.body.data.content, /\/links testar/);
    assert.match(res.body.data.content, /\/monitor/);
    assert.ok(Array.isArray(res.body.data.embeds));
    assert.equal(res.body.data.embeds.length, 5);
    const helpBlob = [
      res.body.data.content,
      ...res.body.data.embeds.map(e => `${e.title}\n${e.description}`)
    ].join('\n');
    assert.match(helpBlob, /\{mencoes\}/);
    assert.match(helpBlob, /limpar/);
    assert.ok(res.body.data.content.length <= 2000);

    let testSourceCalls = 0;
    const services = {
      settingsDefaults: SETTINGS_DEFAULTS,
      async testSource(rawUrl) {
        testSourceCalls += 1;
        return { url: validateSource(rawUrl), products: 3, available: 1, unavailable: 1, unknown: 1 };
      },
      async sendTest() { throw new Error('should not send'); }
    };

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({
        data: linksData('testar', 'https://shop.test/collections/cards/products.json?x=1')
      })),
      x.env, DEFAULTS, validateSource, services
    ));
    assert.equal(testSourceCalls, 1);
    assert.match(res.body.data.content, /só leitura/);
    assert.match(res.body.data.content, /disponíveis: 1/);
    assert.match(res.body.data.content, /indisponíveis: 1/);
    assert.deepEqual(res.body.data.allowed_mentions, { parse: [] });
    assert.deepEqual(await getSources(x.env, DEFAULTS), sourcesBefore);
    assert.equal(x.sql.prepare('SELECT COUNT(*) AS n FROM source_config').get().n, 0);
    assert.deepEqual(x.monitorState(), monitorBefore);

    const timeoutErr = new Error('Request or processing failed');
    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({
        data: linksData('testar', 'https://shop.test/collections/cards')
      })),
      x.env, DEFAULTS, validateSource, {
        settingsDefaults: SETTINGS_DEFAULTS,
        async testSource() { throw timeoutErr; }
      }
    ));
    assert.match(res.body.data.content, /Não foi possível concluir o teste da fonte/);
    assert.equal(res.body.data.content.includes('Request or processing failed'), false);
    assert.deepEqual(await getSources(x.env, DEFAULTS), sourcesBefore);
  } finally { x.sql.close(); }
});

test('unauthorized monitor and testar never read mutate or send', async () => {
  const { keyPair, publicKey } = await makeKeys();
  const x = setup(publicKey);
  try {
    let touched = 0;
    const services = {
      settingsDefaults: SETTINGS_DEFAULTS,
      async testSource() { touched += 1; return { url: 'x', products: 0, available: 0, unavailable: 0, unknown: 0 }; },
      async sendTest() { touched += 1; },
      async getStatus() { touched += 1; return { enabled: false }; }
    };

    const cases = [
      interaction({ member: { permissions: '0' }, data: monitorData('estado') }),
      interaction({ member: { permissions: '0' }, data: monitorData('testar') }),
      interaction({ member: { permissions: '0' }, data: linksData('testar', 'https://shop.test/collections/cards') }),
      interaction({ application_id: '999', data: monitorData('iniciar') }),
      interaction({ guild_id: '111', data: { name: 'ajuda' } })
    ];

    for (const body of cases) {
      const res = await json(await handleLinksInteraction(
        await signedRequest(keyPair.privateKey, body),
        x.env, DEFAULTS, validateSource, services
      ));
      assert.equal(res.body.type, 4);
      assert.equal(touched, 0);
      assert.equal(x.sql.prepare('SELECT COUNT(*) AS n FROM monitor_settings').get().n, 0);
      assert.equal(x.sql.prepare('SELECT COUNT(*) AS n FROM source_config').get().n, 0);
      assert.match(res.body.data.content, /Comando indisponível|Sem permissão/);
    }
  } finally { x.sql.close(); }
});

test('deferred ack then patch for slow services without leaking tokens', async () => {
  const { keyPair, publicKey } = await makeKeys();
  const x = setup(publicKey);
  try {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const patches = [];
    let deferredResolved = false;
    const background = [];

    const { result, logs } = await withCapturedLogs(async () => {
      const services = {
        settingsDefaults: SETTINGS_DEFAULTS,
        waitUntil(promise) { background.push(promise); },
        async fetcher(url, init) {
          patches.push({ url, method: init.method, body: JSON.parse(init.body), headers: init.headers, redirect: init.redirect });
          assert.equal(url.includes(INTERACTION_TOKEN), true);
          assert.equal(url.includes(encodeURIComponent(INTERACTION_TOKEN)), true);
          assert.equal(init.signal instanceof AbortSignal, true);
          return { ok: true, status: 200, async arrayBuffer() { return new ArrayBuffer(0); }, headers: { get() { return null; } } };
        },
        async testSource() {
          await gate;
          return { url: 'https://shop.test/collections/cards', products: 2, available: 2, unavailable: 0, unknown: 0 };
        }
      };

      const pending = handleLinksInteraction(
        await signedRequest(keyPair.privateKey, interactionWithToken({
          data: linksData('testar', 'https://shop.test/collections/cards')
        })),
        x.env, DEFAULTS, validateSource, services
      );

      const res = await json(await pending);
      deferredResolved = true;
      assert.equal(res.body.type, 5);
      assert.equal(res.body.data.flags, 64);
      assert.equal(patches.length, 0);

      release();
      await Promise.all(background);
      return res;
    });

    assert.equal(deferredResolved, true);
    assert.equal(patches.length, 1);
    assert.equal(patches[0].method, 'PATCH');
    assert.match(patches[0].url, new RegExp(`/webhooks/${APP}/`));
    assert.match(patches[0].url, /\/messages\/@original$/);
    assert.equal(patches[0].redirect, 'manual');
    assert.match(patches[0].body.content, /disponíveis: 2/);
    assert.deepEqual(patches[0].body.allowed_mentions, { parse: [] });
    assert.equal(JSON.stringify(patches[0].headers || {}).includes(INTERACTION_TOKEN), false);

    const followups = logs
      .flatMap(e => e.args)
      .map(a => { try { return JSON.parse(a); } catch { return null; } })
      .filter(Boolean)
      .filter(r => r.event === 'discord_followup');
    assert.ok(followups.some(r => r.outcome === 'success' && r.reason === 'patch_ok' && r.attempts === 1));
    assert.ok(followups.every(r => typeof r.diagnostic_id === 'string' && r.diagnostic_id));
    assertNoSensitive(logs, [INTERACTION_TOKEN, publicKey, 'SECRET']);
    assert.equal(result.body.type, 5);
  } finally { x.sql.close(); }
});
test('monitor command sequence persists settings and rejects invalid inputs', async () => {
  const { keyPair, publicKey } = await makeKeys();
  const x = setup(publicKey);
  const userA = '111111111111111111';
  const userB = '222222222222222222';
  const botId = '333333333333333333';
  try {
    const services = {
      settingsDefaults: SETTINGS_DEFAULTS,
      async getStatus() {
        const settings = await getMonitorSettings(x.env, SETTINGS_DEFAULTS);
        return { enabled: settings.enabled, settings, configured: DEFAULTS, sources: {}, pending: 0 };
      },
      async sendTest() { return { status: 'test sent' }; }
    };

    let res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({ data: monitorData('iniciar') })),
      x.env, DEFAULTS, validateSource, services
    ));
    assert.match(res.body.data.content, /Monitor iniciado/);
    assert.equal((await getMonitorSettings(x.env, SETTINGS_DEFAULTS)).enabled, true);

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({ data: monitorData('pausar') })),
      x.env, DEFAULTS, validateSource, services
    ));
    assert.match(res.body.data.content, /Monitor pausado/);
    assert.equal((await getMonitorSettings(x.env, SETTINGS_DEFAULTS)).enabled, false);

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({ data: monitorData('estado') })),
      x.env, DEFAULTS, validateSource, services
    ));
    assert.match(res.body.data.content, /pausado/);
    assert.match(res.body.data.content, /PokeBot/);

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({ data: monitorData('testar') })),
      x.env, DEFAULTS, validateSource, services
    ));
    assert.match(res.body.data.content, /Notificação de teste enviada/);
    assert.equal((await getMonitorSettings(x.env, SETTINGS_DEFAULTS)).enabled, false);

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({
        data: {
          ...monitorData('marcar', [{ name: 'usuario', type: 6, value: userA }]),
          resolved: { users: { [userA]: { id: userA, bot: false, username: 'a' } } }
        }
      })),
      x.env, DEFAULTS, validateSource, services
    ));
    assert.match(res.body.data.content, new RegExp(`<@${userA}>`));
    assert.deepEqual(res.body.data.allowed_mentions, { parse: [] });

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({
        data: {
          ...monitorData('marcar', [{ name: 'usuario', type: 6, value: userA }]),
          resolved: { users: { [userA]: { id: userA, bot: false } } }
        }
      })),
      x.env, DEFAULTS, validateSource, services
    ));
    assert.match(res.body.data.content, /já estava/);

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({
        data: {
          ...monitorData('marcar', [{ name: 'usuario', type: 6, value: botId }]),
          resolved: { users: { [botId]: { id: botId, bot: true } } }
        }
      })),
      x.env, DEFAULTS, validateSource, services
    ));
    assert.match(res.body.data.content, /bots/);

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({
        data: monitorData('marcar', [{ name: 'usuario', type: 6, value: '123' }])
      })),
      x.env, DEFAULTS, validateSource, services
    ));
    assert.match(res.body.data.content, /ID de utilizador inválido/);

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({
        data: {
          ...monitorData('marcar', [{ name: 'usuario', type: 6, value: userB }]),
          resolved: { users: { [userB]: { id: userB, bot: false } } }
        }
      })),
      x.env, DEFAULTS, validateSource, services
    ));
    assert.match(res.body.data.content, /marcado/);

    let settings = await getMonitorSettings(x.env, SETTINGS_DEFAULTS);
    assert.ok(settings.mentionUserIds.includes('207557157858574337'));
    assert.ok(settings.mentionUserIds.includes(userA));
    assert.ok(settings.mentionUserIds.includes(userB));

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({ data: monitorData('mencoes') })),
      x.env, DEFAULTS, validateSource, services
    ));
    assert.match(res.body.data.content, new RegExp(`<@${userA}>`));
    assert.deepEqual(res.body.data.allowed_mentions, { parse: [] });

    for (const id of [...settings.mentionUserIds]) {
      res = await json(await handleLinksInteraction(
        await signedRequest(keyPair.privateKey, interaction({
          data: monitorData('desmarcar', [{ name: 'usuario', type: 6, value: id }])
        })),
        x.env, DEFAULTS, validateSource, services
      ));
      assert.match(res.body.data.content, /desmarcado/);
    }
    settings = await getMonitorSettings(x.env, SETTINGS_DEFAULTS);
    assert.deepEqual(settings.mentionUserIds, []);

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({
        data: monitorData('desmarcar', [{ name: 'usuario', type: 6, value: userA }])
      })),
      x.env, DEFAULTS, validateSource, services
    ));
    assert.match(res.body.data.content, /não estava/);

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({ data: monitorData('mensagem') })),
      x.env, DEFAULTS, validateSource, services
    ));
    assert.match(res.body.data.content, /Modelo atual/);
    assert.match(res.body.data.content, /\{mencoes\}/);

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({
        data: monitorData('mensagem', [{ name: 'texto', type: 3, value: '{tipo} {produto} {url}' }])
      })),
      x.env, DEFAULTS, validateSource, services
    ));
    assert.match(res.body.data.content, /atualizado/);
    assert.equal((await getMonitorSettings(x.env, SETTINGS_DEFAULTS)).messageTemplate, '{tipo} {produto} {url}');

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({
        data: monitorData('mensagem', [{ name: 'texto', type: 3, value: '{nope}' }])
      })),
      x.env, DEFAULTS, validateSource, services
    ));
    assert.match(res.body.data.content, /Modelo de mensagem inválido/);
    assert.equal((await getMonitorSettings(x.env, SETTINGS_DEFAULTS)).messageTemplate, '{tipo} {produto} {url}');

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({ data: monitorData('repor_mensagem') })),
      x.env, DEFAULTS, validateSource, services
    ));
    assert.match(res.body.data.content, /reposto/);
    assert.equal((await getMonitorSettings(x.env, SETTINGS_DEFAULTS)).messageTemplate, '{mencoes}');

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({
        data: monitorData('configurar', [
          { name: 'opcao', type: 3, value: 'alertOnSoldOutListings' },
          { name: 'valor', type: 3, value: 'true' }
        ])
      })),
      x.env, DEFAULTS, validateSource, services
    ));
    assert.match(res.body.data.content, /Opção atualizada/);
    assert.equal((await getMonitorSettings(x.env, SETTINGS_DEFAULTS)).alertOnSoldOutListings, true);

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({
        data: monitorData('configurar', [
          { name: 'opcao', type: 3, value: 'includeKeywords' },
          { name: 'valor', type: 3, value: 'charizard, pikachu' }
        ])
      })),
      x.env, DEFAULTS, validateSource, services
    ));
    assert.deepEqual((await getMonitorSettings(x.env, SETTINGS_DEFAULTS)).includeKeywords, ['charizard', 'pikachu']);

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({
        data: monitorData('configurar', [
          { name: 'opcao', type: 3, value: 'includeKeywords' },
          { name: 'valor', type: 3, value: 'limpar' }
        ])
      })),
      x.env, DEFAULTS, validateSource, services
    ));
    assert.deepEqual((await getMonitorSettings(x.env, SETTINGS_DEFAULTS)).includeKeywords, []);

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({
        data: monitorData('configurar', [
          { name: 'opcao', type: 3, value: 'checkIntervalSeconds' },
          { name: 'valor', type: 3, value: '120' }
        ])
      })),
      x.env, DEFAULTS, validateSource, services
    ));
    assert.equal((await getMonitorSettings(x.env, SETTINGS_DEFAULTS)).checkIntervalSeconds, 120);

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({
        data: monitorData('configurar', [
          { name: 'opcao', type: 3, value: 'enabled' },
          { name: 'valor', type: 3, value: 'true' }
        ])
      })),
      x.env, DEFAULTS, validateSource, services
    ));
    assert.match(res.body.data.content, /Opção de configuração desconhecida|Não foi possível processar/);
    assert.equal((await getMonitorSettings(x.env, SETTINGS_DEFAULTS)).enabled, false);

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({
        data: monitorData('configurar', [
          { name: 'opcao', type: 3, value: 'alertOnNewProducts' },
          { name: 'valor', type: 3, value: 'yes' }
        ])
      })),
      x.env, DEFAULTS, validateSource, services
    ));
    assert.match(res.body.data.content, /Valor de configuração inválido/);

    res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({
        data: linksData('testar', 'https://shop.test/collections/cards')
      })),
      x.env, DEFAULTS, validateSource, {
        settingsDefaults: SETTINGS_DEFAULTS,
        async testSource(rawUrl) {
          return { url: validateSource(rawUrl), products: 1, available: 1, unavailable: 0, unknown: 0 };
        }
      }
    ));
    assert.match(res.body.data.content, /só leitura/);
    assert.equal((await getMonitorSettings(x.env, SETTINGS_DEFAULTS)).enabled, false);
    assert.equal(x.sql.prepare('SELECT COUNT(*) AS n FROM source_config').get().n, 0);
  } finally { x.sql.close(); }
});

test('monitor estado surfaces healthy baseline and blocked sources', async () => {
  const { keyPair, publicKey } = await makeKeys();
  const x = setup(publicKey);
  const healthyUrl = 'https://shop.test/collections/cards';
  const blockedUrl = 'https://blocked.test/collections/pokemon';
  try {
    const services = {
      settingsDefaults: SETTINGS_DEFAULTS,
      async getStatus() {
        return {
          enabled: true,
          pending: 1,
          lastError: null,
          configured: [healthyUrl, blockedUrl],
          sources: {
            [healthyUrl]: {
              initialized: true,
              productCount: 5,
              blocked: false,
              lastError: null,
              lastCheck: Date.parse('2026-09-07T10:00:00.000Z')
            },
            [blockedUrl]: {
              initialized: true,
              productCount: 0,
              blocked: true,
              lastError: 'Store HTTP 403',
              lastCheck: Date.parse('2026-09-07T09:00:00.000Z'),
              nextCheck: Date.parse('2026-09-07T11:00:00.000Z')
            }
          },
          settings: await getMonitorSettings(x.env, SETTINGS_DEFAULTS)
        };
      }
    };

    const res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({ data: monitorData('estado') })),
      x.env, DEFAULTS, validateSource, services
    ));
    assert.match(res.body.data.content, /Monitor: ativo/);
    assert.match(res.body.data.content, /Fontes configuradas: 2/);
    assert.match(res.body.data.content, /shop\.test\/collections\/cards — ok/);
    assert.match(res.body.data.content, /produtos=5/);
    assert.match(res.body.data.content, /bloqueada/);
    assert.match(res.body.data.content, /Store HTTP 403/);
    assert.equal(res.body.data.content.includes('SECRET'), false);
    assert.deepEqual(res.body.data.allowed_mentions, { parse: [] });
  } finally { x.sql.close(); }
});

test('followup 429 long delay skips retry; short delay retries within budget', async () => {
  const { keyPair, publicKey } = await makeKeys();
  const x = setup(publicKey);
  try {
    const longCalls = [];
    const longBackground = [];
    const { result: longResult, logs: longLogs } = await withCapturedLogs(async () => {
      const services = {
        settingsDefaults: SETTINGS_DEFAULTS,
        waitUntil(promise) { longBackground.push(promise); },
        async fetcher(url, init) {
          longCalls.push({ url, init, at: Date.now() });
          return {
            ok: false,
            status: 429,
            headers: { get(name) { return name === 'Retry-After' ? '10' : null; } },
            async arrayBuffer() { return new ArrayBuffer(0); }
          };
        },
        async testSource() {
          return { url: 'https://shop.test/collections/cards', products: 1, available: 1, unavailable: 0, unknown: 0 };
        }
      };
      const started = Date.now();
      const res = await handleLinksInteraction(
        await signedRequest(keyPair.privateKey, interactionWithToken({
          data: linksData('testar', 'https://shop.test/collections/cards')
        })),
        x.env, DEFAULTS, validateSource, services
      );
      await Promise.all(longBackground);
      return { res, elapsed: Date.now() - started };
    });

    assert.equal((await longResult.res.json()).type, 5);
    assert.equal(longCalls.length, 1);
    assert.ok(longResult.elapsed < 2000, `elapsed ${longResult.elapsed}`);
    const followups = longLogs
      .flatMap(e => e.args)
      .map(a => { try { return JSON.parse(a); } catch { return null; } })
      .filter(Boolean)
      .filter(r => r.event === 'discord_followup');
    assert.ok(followups.some(r => r.reason === 'patch_failed' && r.http_status === 429));
    assert.equal(JSON.stringify(longLogs).includes(INTERACTION_TOKEN), false);

    const shortCalls = [];
    const shortBackground = [];
    const servicesShort = {
      settingsDefaults: SETTINGS_DEFAULTS,
      waitUntil(promise) { shortBackground.push(promise); },
      async fetcher(url, init) {
        shortCalls.push(Date.now());
        if (shortCalls.length === 1) {
          return {
            ok: false,
            status: 429,
            headers: { get(name) { return name === 'Retry-After' ? '0' : null; } },
            async arrayBuffer() { return new ArrayBuffer(0); }
          };
        }
        return {
          ok: true,
          status: 200,
          headers: { get() { return null; } },
          async arrayBuffer() { return new ArrayBuffer(0); }
        };
      },
      async testSource() {
        return { url: 'https://shop.test/collections/cards', products: 1, available: 1, unavailable: 0, unknown: 0 };
      }
    };
    const shortRes = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interactionWithToken({
        data: linksData('testar', 'https://shop.test/collections/cards')
      })),
      x.env, DEFAULTS, validateSource, servicesShort
    ));
    await Promise.all(shortBackground);
    assert.equal(shortRes.body.type, 5);
    assert.equal(shortCalls.length, 2);
  } finally { x.sql.close(); }
});

test('malformed monitor mutation options do not mutate settings', async () => {
  const { keyPair, publicKey } = await makeKeys();
  const x = setup(publicKey);
  const userA = '111111111111111111';
  try {
    const services = { settingsDefaults: SETTINGS_DEFAULTS };
    await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interaction({ data: monitorData('iniciar') })),
      x.env, DEFAULTS, validateSource, services
    );
    const before = await getMonitorSettings(x.env, SETTINGS_DEFAULTS);

    const badCases = [
      monitorData('marcar', [
        { name: 'usuario', type: 6, value: userA },
        { name: 'extra', type: 3, value: 'x' }
      ]),
      monitorData('marcar', [
        { name: 'usuario', type: 6, value: userA },
        { name: 'usuario', type: 6, value: userA }
      ]),
      monitorData('marcar', [{ name: 'usuario', type: 3, value: userA }]),
      monitorData('desmarcar', []),
      monitorData('configurar', [{ name: 'opcao', type: 3, value: 'alertOnNewProducts' }]),
      monitorData('configurar', [
        { name: 'opcao', type: 3, value: 'alertOnNewProducts' },
        { name: 'valor', type: 3, value: 'true' },
        { name: 'extra', type: 3, value: 'nope' }
      ]),
      monitorData('configurar', [
        { name: 'opcao', type: 3, value: 'alertOnNewProducts' },
        { name: 'valor', type: 6, value: userA }
      ]),
      monitorData('mensagem', [
        { name: 'texto', type: 3, value: '{tipo}' },
        { name: 'extra', type: 3, value: 'x' }
      ]),
      monitorData('mensagem', [{ name: 'texto', type: 6, value: userA }])
    ];

    for (const data of badCases) {
      const res = await json(await handleLinksInteraction(
        await signedRequest(keyPair.privateKey, interaction({
          data: {
            ...data,
            resolved: { users: { [userA]: { id: userA, bot: false } } }
          }
        })),
        x.env, DEFAULTS, validateSource, services
      ));
      assert.match(res.body.data.content, /Não foi possível processar o pedido/);
      assert.deepEqual(await getMonitorSettings(x.env, SETTINGS_DEFAULTS), before);
    }
  } finally { x.sql.close(); }
});

test('ajuda returns immediate type4 even with waitUntil and never touches followup or DB', async () => {
  const { keyPair, publicKey } = await makeKeys();
  const x = setup(publicKey);
  try {
    let waitUntilCalls = 0;
    let fetcherCalls = 0;
    let dbCalls = 0;
    const failingDB = {
      prepare(query) {
        dbCalls += 1;
        throw new Error(`DB should not be called: ${query}`);
      }
    };
    const env = { ...x.env, DB: failingDB };
    const services = {
      settingsDefaults: SETTINGS_DEFAULTS,
      waitUntil() { waitUntilCalls += 1; throw new Error('waitUntil should not run for ajuda'); },
      async fetcher() { fetcherCalls += 1; throw new Error('fetcher should not run for ajuda'); },
      async testSource() { throw new Error('testSource should not run'); },
      async sendTest() { throw new Error('sendTest should not run'); },
      async getStatus() { throw new Error('getStatus should not run'); }
    };

    const res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interactionWithToken({ data: { name: 'ajuda' } })),
      env, DEFAULTS, validateSource, services
    ));
    assert.equal(res.status, 200);
    assert.equal(res.body.type, 4);
    assert.equal(res.body.data.flags, 64);
    assert.deepEqual(res.body.data.allowed_mentions, { parse: [] });
    assert.match(res.body.data.content, /\/links testar/);
    assert.match(res.body.data.content, /\/monitor/);
    assert.ok(Array.isArray(res.body.data.embeds));
    assert.equal(res.body.data.embeds.length, 5);
    assert.equal(waitUntilCalls, 0);
    assert.equal(fetcherCalls, 0);
    assert.equal(dbCalls, 0);

    const bad = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interactionWithToken({
        data: { name: 'ajuda', options: [{ name: 'extra', type: 3, value: 'x' }] }
      })),
      env, DEFAULTS, validateSource, services
    ));
    assert.equal(bad.status, 200);
    assert.equal(bad.body.type, 4);
    assert.match(bad.body.data.content, /Não foi possível processar o pedido/);
    assert.equal(waitUntilCalls, 0);
    assert.equal(fetcherCalls, 0);
    assert.equal(dbCalls, 0);

    const denied = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interactionWithToken({
        member: { permissions: '0' },
        data: { name: 'ajuda' }
      })),
      env, DEFAULTS, validateSource, services
    ));
    assert.equal(denied.body.type, 4);
    assert.match(denied.body.data.content, /Sem permissão/);
    assert.equal(waitUntilCalls, 0);
    assert.equal(fetcherCalls, 0);
    assert.equal(dbCalls, 0);
  } finally { x.sql.close(); }
});

function followupRecords(logs) {
  const out = [];
  for (const entry of logs) {
    for (const arg of entry.args) {
      try {
        const parsed = JSON.parse(arg);
        if (parsed && parsed.event === 'discord_followup') out.push({ level: entry.level, ...parsed });
      } catch { /* ignore */ }
    }
  }
  return out;
}

test('fast commands prefer type4 within budget even with waitUntil; no PATCH', async () => {
  const { keyPair, publicKey } = await makeKeys();
  const x = setup(publicKey);
  try {
    const background = [];
    let fetcherCalls = 0;
    const services = {
      settingsDefaults: SETTINGS_DEFAULTS,
      waitUntil(promise) { background.push(promise); },
      async fetcher() {
        fetcherCalls += 1;
        throw new Error('fetcher should not run for fast CRUD');
      }
    };

    const res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interactionWithToken({
        data: linksData('adicionar', 'https://shop.test/collections/cards')
      })),
      x.env, DEFAULTS, validateSource, services
    ));
    assert.equal(res.body.type, 4);
    assert.equal(res.body.data.flags, 64);
    assert.deepEqual(res.body.data.allowed_mentions, { parse: [] });
    assert.match(res.body.data.content, /Fonte adicionada/);
    assert.equal(fetcherCalls, 0);
    assert.equal(background.length, 0);
    assert.deepEqual(await getSources(x.env, DEFAULTS), [...DEFAULTS, 'https://shop.test/collections/cards']);

    const list = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interactionWithToken({ data: linksData('listar') })),
      x.env, DEFAULTS, validateSource, services
    ));
    assert.equal(list.body.type, 4);
    assert.equal(background.length, 0);

    const monitor = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interactionWithToken({ data: monitorData('iniciar') })),
      x.env, DEFAULTS, validateSource, services
    ));
    assert.equal(monitor.body.type, 4);
    assert.match(monitor.body.data.content, /Monitor iniciado/);
    assert.equal(background.length, 0);
  } finally { x.sql.close(); }
});

test('slow D1 falls back to type5 without double mutation', async () => {
  const { keyPair, publicKey } = await makeKeys();
  const x = setup(publicKey);
  try {
    let mutateRuns = 0;
    const background = [];
    const patches = [];
    const origPrepare = x.env.DB.prepare.bind(x.env.DB);
    x.env.DB.prepare = (query) => {
      const stmt = origPrepare(query);
      if (typeof query === 'string' && query.includes('UPDATE source_config SET sources')) {
        const origRun = stmt.run.bind(stmt);
        stmt.run = async (...args) => {
          mutateRuns += 1;
          await new Promise(resolve => setTimeout(resolve, 1500));
          return origRun(...args);
        };
      }
      return stmt;
    };

    const services = {
      settingsDefaults: SETTINGS_DEFAULTS,
      waitUntil(promise) { background.push(promise); },
      async fetcher(url, init) {
        patches.push(JSON.parse(init.body));
        return { ok: true, status: 200, async arrayBuffer() { return new ArrayBuffer(0); }, headers: { get() { return null; } } };
      }
    };

    const res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interactionWithToken({
        data: linksData('adicionar', 'https://slow.test/collections/cards')
      })),
      x.env, DEFAULTS, validateSource, services
    ));
    assert.equal(res.body.type, 5);
    assert.equal(res.body.data.flags, 64);
    assert.equal(background.length, 1);
    await Promise.all(background);
    assert.equal(mutateRuns, 1);
    assert.equal(patches.length, 1);
    assert.match(patches[0].content, /Fonte adicionada|já estava/);
    assert.deepEqual(await getSources(x.env, DEFAULTS), [...DEFAULTS, 'https://slow.test/collections/cards']);
  } finally { x.sql.close(); }
});

test('network monitor testar defers immediately with waitUntil', async () => {
  const { keyPair, publicKey } = await makeKeys();
  const x = setup(publicKey);
  try {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const background = [];
    const services = {
      settingsDefaults: SETTINGS_DEFAULTS,
      waitUntil(promise) { background.push(promise); },
      async fetcher() {
        return { ok: true, status: 200, async arrayBuffer() { return new ArrayBuffer(0); }, headers: { get() { return null; } } };
      },
      async sendTest() {
        await gate;
        return { status: 'test sent' };
      }
    };

    const res = await json(await handleLinksInteraction(
      await signedRequest(keyPair.privateKey, interactionWithToken({ data: monitorData('testar') })),
      x.env, DEFAULTS, validateSource, services
    ));
    assert.equal(res.body.type, 5);
    assert.equal(background.length, 1);
    release();
    await Promise.all(background);
  } finally { x.sql.close(); }
});

test('followup retries early 404 ack-miss then succeeds; permanent failure stays bounded', async () => {
  const { keyPair, publicKey } = await makeKeys();
  const x = setup(publicKey);
  try {
    const background = [];
    let calls = 0;
    const { logs } = await withCapturedLogs(async () => {
      const services = {
        settingsDefaults: SETTINGS_DEFAULTS,
        waitUntil(promise) { background.push(promise); },
        async fetcher() {
          calls += 1;
          if (calls < 3) {
            return {
              ok: false,
              status: 404,
              async json() { return { code: 10015, message: 'Unknown Webhook SECRET_TOKEN' }; },
              headers: { get() { return null; } }
            };
          }
          return { ok: true, status: 200, async arrayBuffer() { return new ArrayBuffer(0); }, headers: { get() { return null; } } };
        },
        async testSource() {
          return { url: 'https://shop.test/collections/cards', products: 1, available: 1, unavailable: 0, unknown: 0 };
        }
      };
      const res = await json(await handleLinksInteraction(
        await signedRequest(keyPair.privateKey, interactionWithToken({
          data: linksData('testar', 'https://shop.test/collections/cards')
        })),
        x.env, DEFAULTS, validateSource, services
      ));
      assert.equal(res.body.type, 5);
      await Promise.all(background);
      return res;
    });

    assert.equal(calls, 3);
    const followups = followupRecords(logs);
    assert.ok(followups.some(r => r.outcome === 'success' && r.reason === 'patch_ok' && r.attempts === 3));
    assert.ok(followups.every(r => typeof r.diagnostic_id === 'string'));
    assert.equal(JSON.stringify(logs).includes('SECRET_TOKEN'), false);
    assert.equal(JSON.stringify(logs).includes(INTERACTION_TOKEN), false);
    assert.equal(JSON.stringify(logs).includes('Unknown Webhook'), false);

    const failBackground = [];
    let failCalls = 0;
    const failed = await withCapturedLogs(async () => {
      const services = {
        settingsDefaults: SETTINGS_DEFAULTS,
        waitUntil(promise) { failBackground.push(promise); },
        async fetcher() {
          failCalls += 1;
          return {
            ok: false,
            status: 404,
            async json() { return { code: 10008, message: 'Unknown Message SECRET_TOKEN' }; },
            headers: { get() { return null; } }
          };
        },
        async testSource() {
          return { url: 'https://shop.test/collections/cards', products: 1, available: 1, unavailable: 0, unknown: 0 };
        }
      };
      await handleLinksInteraction(
        await signedRequest(keyPair.privateKey, interactionWithToken({
          data: linksData('testar', 'https://shop.test/collections/cards')
        })),
        x.env, DEFAULTS, validateSource, services
      );
      await Promise.all(failBackground);
    });

    assert.equal(failCalls, 3);
    const failFollowups = followupRecords(failed.logs);
    assert.ok(failFollowups.some(r => r.outcome === 'failure' && r.http_status === 404 && r.discord_error_code === 10008 && r.attempts === 3));
    assert.equal(JSON.stringify(failed.logs).includes('SECRET_TOKEN'), false);
    assert.equal(JSON.stringify(failed.logs).includes(INTERACTION_TOKEN), false);
  } finally { x.sql.close(); }
});

test('hanging deferred work times out once; late settle does not second-edit', async (t) => {
  const { keyPair, publicKey } = await makeKeys();
  const x = setup(publicKey);
  const origAbortTimeout = AbortSignal.timeout.bind(AbortSignal);
  const abortTimeoutMs = [];
  try {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const background = [];
    const patches = [];
    let testSourceCalls = 0;
    const req = await signedRequest(keyPair.privateKey, interactionWithToken({
      data: linksData('testar', 'https://shop.test/collections/cards')
    }));

    AbortSignal.timeout = (ms) => {
      abortTimeoutMs.push(ms);
      return origAbortTimeout(ms);
    };

    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });

    const { logs } = await withCapturedLogs(async () => {
      const services = {
        settingsDefaults: SETTINGS_DEFAULTS,
        waitUntil(promise) { background.push(promise); },
        async fetcher(url, init) {
          patches.push(JSON.parse(init.body));
          return { ok: true, status: 200, async arrayBuffer() { return new ArrayBuffer(0); }, headers: { get() { return null; } } };
        },
        async testSource() {
          testSourceCalls += 1;
          await gate;
          return { url: 'https://shop.test/collections/cards', products: 9, available: 9, unavailable: 0, unknown: 0 };
        }
      };

      const res = await json(await handleLinksInteraction(req, x.env, DEFAULTS, validateSource, services));
      assert.equal(res.body.type, 5);
      assert.equal(patches.length, 0);
      assert.equal(background.length, 1);

      const pending = Promise.all(background);
      t.mock.timers.tick(21000);
      await pending;

      assert.equal(patches.length, 1);
      assert.match(patches[0].content, /Não foi possível confirmar o resultado dentro do prazo/);
      assert.match(patches[0].content, /pode ainda terminar/);
      assert.equal(patches[0].content.includes('cancelad'), false);
      assert.deepEqual(abortTimeoutMs, [7000]);
      assert.equal(abortTimeoutMs.includes(8000), false);

      release();
      await gate;
      await Promise.resolve();
      await Promise.resolve();
      t.mock.timers.tick(5000);
      assert.equal(patches.length, 1);
      assert.equal(testSourceCalls, 1);
      assert.deepEqual(abortTimeoutMs, [7000]);
      return res;
    });

    const followups = followupRecords(logs);
    assert.ok(followups.some(r => r.reason === 'work_started' && r.outcome === 'pending' && r.stage === 'work' && r.attempts === 0));
    assert.ok(followups.some(r => r.reason === 'work_timeout' && r.outcome === 'failure' && r.stage === 'work' && r.attempts === 0));
    assert.ok(followups.some(r => r.reason === 'patch_ok' && r.outcome === 'success'));
    assert.equal(followups.some(r => r.reason === 'work_settled'), false);
    const ids = [...new Set(followups.map(r => r.diagnostic_id))];
    assert.equal(ids.length, 1);
    assert.ok(typeof ids[0] === 'string' && ids[0]);
    assertNoSensitive(logs, [INTERACTION_TOKEN, publicKey, 'SECRET', 'https://shop.test/collections/cards']);
  } finally {
    AbortSignal.timeout = origAbortTimeout;
    x.sql.close();
  }
});

test('quick deferred settle clears work timer and does not timeout-edit', async (t) => {
  const { keyPair, publicKey } = await makeKeys();
  const x = setup(publicKey);
  try {
    const background = [];
    const patches = [];
    const req = await signedRequest(keyPair.privateKey, interactionWithToken({
      data: linksData('testar', 'https://shop.test/collections/cards')
    }));

    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });

    const { logs } = await withCapturedLogs(async () => {
      const services = {
        settingsDefaults: SETTINGS_DEFAULTS,
        waitUntil(promise) { background.push(promise); },
        async fetcher(url, init) {
          patches.push(JSON.parse(init.body));
          return { ok: true, status: 200, async arrayBuffer() { return new ArrayBuffer(0); }, headers: { get() { return null; } } };
        },
        async testSource() {
          return { url: 'https://shop.test/collections/cards', products: 2, available: 2, unavailable: 0, unknown: 0 };
        }
      };

      const res = await json(await handleLinksInteraction(req, x.env, DEFAULTS, validateSource, services));
      assert.equal(res.body.type, 5);
      await Promise.all(background);
      assert.equal(patches.length, 1);
      assert.match(patches[0].content, /disponíveis: 2/);

      t.mock.timers.tick(30000);
      await Promise.resolve();
      assert.equal(patches.length, 1);
      return res;
    });

    const followups = followupRecords(logs);
    assert.ok(followups.some(r => r.reason === 'work_started' && r.stage === 'work' && r.attempts === 0));
    assert.ok(followups.some(r => r.reason === 'work_settled' && r.outcome === 'pending' && r.stage === 'work' && r.attempts === 0));
    assert.ok(followups.some(r => r.reason === 'patch_ok'));
    assert.equal(followups.some(r => r.reason === 'work_timeout'), false);
    const ids = [...new Set(followups.map(r => r.diagnostic_id))];
    assert.equal(ids.length, 1);
    assertNoSensitive(logs, [INTERACTION_TOKEN, publicKey, 'SECRET']);
  } finally { x.sql.close(); }
});

test('PATCH rejects redirects without following or reporting success', async () => {
  const { keyPair, publicKey } = await makeKeys();
  const x = setup(publicKey);
  try {
    for (const status of [301, 302, 303, 307, 308]) {
      const background = [];
      let calls = 0;
      const { logs } = await withCapturedLogs(async () => {
        const response = await handleLinksInteraction(
          await signedRequest(keyPair.privateKey, interactionWithToken({ data: monitorData('testar') })),
          x.env, DEFAULTS, validateSource, {
            settingsDefaults: SETTINGS_DEFAULTS,
            waitUntil(p) { background.push(p); },
            async sendTest() {},
            async fetcher(_url, init) {
              calls++;
              assert.equal(init.redirect, 'manual');
              return new Response(null, { status, headers: { Location: 'https://other.test/target' } });
            }
          }
        );
        assert.equal((await response.json()).type, 5);
        await Promise.all(background);
      });
      assert.equal(calls, 1);
      const records = followupRecords(logs);
      assert.ok(records.some(r => r.reason === 'patch_failed' && r.http_status === status));
      assert.equal(records.some(r => r.reason === 'patch_ok'), false);
      assertNoSensitive(logs, [INTERACTION_TOKEN, publicKey, 'https://other.test/target']);
    }
  } finally { x.sql.close(); }
});

test('PATCH network error then 200 retries once; one business call', async () => {
  const { keyPair, publicKey } = await makeKeys();
  const x = setup(publicKey);
  try {
    const background = [];
    let fetchCalls = 0;
    let testSourceCalls = 0;
    const bodies = [];

    const { logs } = await withCapturedLogs(async () => {
      const services = {
        settingsDefaults: SETTINGS_DEFAULTS,
        waitUntil(promise) { background.push(promise); },
        async fetcher(url, init) {
          fetchCalls += 1;
          bodies.push(init.body);
          if (fetchCalls === 1) throw new Error('network SECRET_TOKEN');
          return { ok: true, status: 200, async arrayBuffer() { return new ArrayBuffer(0); }, headers: { get() { return null; } } };
        },
        async testSource() {
          testSourceCalls += 1;
          return { url: 'https://shop.test/collections/cards', products: 1, available: 1, unavailable: 0, unknown: 0 };
        }
      };

      const res = await json(await handleLinksInteraction(
        await signedRequest(keyPair.privateKey, interactionWithToken({
          data: linksData('testar', 'https://shop.test/collections/cards')
        })),
        x.env, DEFAULTS, validateSource, services
      ));
      assert.equal(res.body.type, 5);
      await Promise.all(background);
      return res;
    });

    assert.equal(fetchCalls, 2);
    assert.equal(testSourceCalls, 1);
    assert.equal(bodies[0], bodies[1]);
    const followups = followupRecords(logs);
    assert.ok(followups.some(r => r.reason === 'patch_ok' && r.attempts === 2));
    assert.ok(followups.some(r => r.reason === 'work_settled' && r.stage === 'work'));
    const ids = [...new Set(followups.map(r => r.diagnostic_id))];
    assert.equal(ids.length, 1);
    assertNoSensitive(logs, [INTERACTION_TOKEN, publicKey, 'SECRET_TOKEN']);
  } finally { x.sql.close(); }
});

test('repeated PATCH network failure stays bounded and safe', async () => {
  const { keyPair, publicKey } = await makeKeys();
  const x = setup(publicKey);
  try {
    const background = [];
    let fetchCalls = 0;
    let testSourceCalls = 0;

    const { logs } = await withCapturedLogs(async () => {
      const services = {
        settingsDefaults: SETTINGS_DEFAULTS,
        waitUntil(promise) { background.push(promise); },
        async fetcher() {
          fetchCalls += 1;
          throw new Error('network SECRET_TOKEN boom');
        },
        async testSource() {
          testSourceCalls += 1;
          return { url: 'https://shop.test/collections/cards', products: 1, available: 1, unavailable: 0, unknown: 0 };
        }
      };

      const res = await json(await handleLinksInteraction(
        await signedRequest(keyPair.privateKey, interactionWithToken({
          data: linksData('testar', 'https://shop.test/collections/cards')
        })),
        x.env, DEFAULTS, validateSource, services
      ));
      assert.equal(res.body.type, 5);
      await Promise.all(background);
      return res;
    });

    assert.equal(testSourceCalls, 1);
    assert.equal(fetchCalls, 2);
    assert.ok(fetchCalls <= 3);
    const followups = followupRecords(logs);
    assert.ok(followups.some(r => r.reason === 'patch_network_error' && r.outcome === 'failure' && r.attempts === 2));
    assert.ok(followups.every(r => typeof r.diagnostic_id === 'string' && r.diagnostic_id));
    const ids = [...new Set(followups.map(r => r.diagnostic_id))];
    assert.equal(ids.length, 1);
    assertNoSensitive(logs, [INTERACTION_TOKEN, publicKey, 'SECRET_TOKEN', 'boom']);
  } finally { x.sql.close(); }
});
