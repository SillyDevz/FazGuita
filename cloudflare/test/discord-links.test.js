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
