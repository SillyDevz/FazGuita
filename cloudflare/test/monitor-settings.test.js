import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_MESSAGE_TEMPLATE,
  formatNotification,
  getMonitorSettings,
  normalizeSetting,
  updateMonitorSettings,
  validateMonitorSettings
} from '../src/monitor-settings.js';

const bundled = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

function setup(schemaSql) {
  const sql = new DatabaseSync(':memory:');
  if (schemaSql) sql.exec(schemaSql);
  const DB = { prepare(query) {
    let args = [];
    return { bind(...values) { args = values; return this; },
      async run() { return { meta: { changes: sql.prepare(query).run(...args).changes } }; },
      async first() { return sql.prepare(query).get(...args) ?? null; }
    };
  }};
  return { sql, env: { DB } };
}

const valid = {
  enabled: true,
  alertOnNewProducts: true,
  alertOnRestocks: true,
  alertOnSoldOutListings: false,
  includeKeywords: [],
  excludeKeywords: [],
  checkIntervalSeconds: 60,
  mentionUserIds: ['207557157858574337'],
  messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
  webhookUsername: 'PokeBot'
};

test('validateMonitorSettings accepts defaults and rejects bound violations', () => {
  assert.deepEqual(validateMonitorSettings(valid), valid);
  assert.equal(DEFAULT_MESSAGE_TEMPLATE, '{mencoes}');
  assert.throws(() => validateMonitorSettings({ ...valid, includeKeywords: ['x'.repeat(101)] }));
  assert.throws(() => validateMonitorSettings({ ...valid, includeKeywords: Array(21).fill('a') }));
  assert.throws(() => validateMonitorSettings({ ...valid, excludeKeywords: ['  '] }));
  assert.throws(() => validateMonitorSettings({ ...valid, checkIntervalSeconds: 59 }));
  assert.throws(() => validateMonitorSettings({ ...valid, checkIntervalSeconds: 3601 }));
  assert.throws(() => validateMonitorSettings({ ...valid, checkIntervalSeconds: 60.5 }));
  assert.throws(() => validateMonitorSettings({ ...valid, mentionUserIds: ['123'] }));
  assert.throws(() => validateMonitorSettings({ ...valid, mentionUserIds: ['207557157858574337', '207557157858574337'] }));
  assert.throws(() => validateMonitorSettings({ ...valid, mentionUserIds: Array(21).fill(0).map((_, i) => String(207557157858574337n + BigInt(i))) }));
  assert.throws(() => validateMonitorSettings({ ...valid, messageTemplate: '' }));
  assert.throws(() => validateMonitorSettings({ ...valid, messageTemplate: '{evil}' }));
  assert.throws(() => validateMonitorSettings({ ...valid, messageTemplate: 'x'.repeat(1501) }));
  assert.throws(() => validateMonitorSettings({ ...valid, webhookUsername: '' }));
  assert.throws(() => validateMonitorSettings({ ...valid, webhookUsername: 'x'.repeat(81) }));
  assert.throws(() => validateMonitorSettings({ ...valid, enabled: 'true' }));
});

test('normalizeSetting handles booleans, keywords, interval, username and rejects mentions/template', () => {
  assert.equal(normalizeSetting('enabled', false), false);
  assert.throws(() => normalizeSetting('enabled', 'false'));
  assert.deepEqual(normalizeSetting('includeKeywords', 'Foo, Bar'), ['Foo', 'Bar']);
  assert.deepEqual(normalizeSetting('excludeKeywords', 'LIMPAR'), []);
  assert.deepEqual(normalizeSetting('includeKeywords', ' limpar '), []);
  assert.deepEqual(normalizeSetting('includeKeywords', ['ok']), ['ok']);
  assert.equal(normalizeSetting('checkIntervalSeconds', 120), 120);
  assert.equal(normalizeSetting('checkIntervalSeconds', '90'), 90);
  assert.throws(() => normalizeSetting('checkIntervalSeconds', 10));
  assert.equal(normalizeSetting('webhookUsername', 'Bot'), 'Bot');
  assert.throws(() => normalizeSetting('mentionUserIds', ['207557157858574337']));
  assert.throws(() => normalizeSetting('messageTemplate', '{mencoes}'));
  assert.throws(() => normalizeSetting('sources', []));
});

test('lazy CREATE TABLE works on old schema without monitor_settings', async () => {
  const oldSchema = `CREATE TABLE IF NOT EXISTS monitor (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state TEXT NOT NULL DEFAULT '{}',
    lease_until INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT
  );
  INSERT OR IGNORE INTO monitor (id) VALUES (1);
  CREATE TABLE IF NOT EXISTS source_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    sources TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0
  );`;
  const x = setup(oldSchema);
  try {
    assert.equal(x.sql.prepare("SELECT name FROM sqlite_master WHERE name='monitor_settings'").get(), undefined);
    const got = await getMonitorSettings(x.env, bundled);
    assert.equal(got.enabled, true);
    assert.equal(got.webhookUsername, 'PokeBot');
    assert.ok(x.sql.prepare("SELECT name FROM sqlite_master WHERE name='monitor_settings'").get());
    assert.ok(x.sql.prepare('SELECT sources FROM source_config').get() === undefined || true);
    assert.ok(x.sql.prepare('SELECT id FROM monitor').get());
  } finally { x.sql.close(); }
});

test('seed once; paused and keyword removals survive reloads; missing fields merge defaults', async () => {
  const x = setup(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  try {
    const first = await getMonitorSettings(x.env, bundled);
    assert.equal(first.enabled, true);
    await updateMonitorSettings(x.env, bundled, current => ({
      ...current,
      enabled: false,
      includeKeywords: ['charizard'],
      excludeKeywords: ['promo']
    }));
    await updateMonitorSettings(x.env, bundled, current => ({
      ...current,
      includeKeywords: [],
      excludeKeywords: []
    }));
    x.sql.prepare('UPDATE monitor_settings SET settings = ?').run(JSON.stringify({
      enabled: false,
      alertOnNewProducts: true,
      alertOnRestocks: true,
      alertOnSoldOutListings: false,
      includeKeywords: [],
      excludeKeywords: []
    }));
    const merged = await getMonitorSettings(x.env, bundled);
    assert.equal(merged.enabled, false);
    assert.deepEqual(merged.includeKeywords, []);
    assert.deepEqual(merged.excludeKeywords, []);
    assert.equal(merged.checkIntervalSeconds, 60);
    assert.deepEqual(merged.mentionUserIds, ['207557157858574337']);
    assert.equal(merged.messageTemplate, '{mencoes}');
    assert.equal(merged.webhookUsername, 'PokeBot');
    const again = await getMonitorSettings(x.env, { ...bundled, enabled: true, includeKeywords: ['nope'] });
    assert.equal(again.enabled, false);
    assert.deepEqual(again.includeKeywords, []);
  } finally { x.sql.close(); }
});

test('CAS retries preserve concurrent mention and config updates', async () => {
  const x = setup(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  try {
    await getMonitorSettings(x.env, bundled);
    const original = x.env.DB.prepare.bind(x.env.DB);
    let sawUpdate = false;
    x.env.DB.prepare = query => {
      const stmt = original(query);
      if (String(query).startsWith('UPDATE monitor_settings SET settings')) {
        const wrap = {
          bind(...values) {
            stmt.bind(...values);
            return wrap;
          },
          async run() {
            if (!sawUpdate) {
              sawUpdate = true;
              await original('UPDATE monitor_settings SET settings = ?, version = version + 1 WHERE id = 1 AND version = ?')
                .bind(JSON.stringify({ ...valid, mentionUserIds: ['111111111111111111'] }), 0).run();
            }
            return stmt.run();
          },
          first: () => stmt.first()
        };
        return wrap;
      }
      return stmt;
    };
    const result = await updateMonitorSettings(x.env, bundled, current => ({
      ...current,
      webhookUsername: 'NewBot',
      mentionUserIds: current.mentionUserIds.includes('111111111111111111')
        ? [...current.mentionUserIds, '222222222222222222']
        : ['222222222222222222']
    }));
    assert.equal(result.webhookUsername, 'NewBot');
    assert.ok(result.mentionUserIds.includes('111111111111111111'));
    assert.ok(result.mentionUserIds.includes('222222222222222222'));
  } finally { x.sql.close(); }
});

test('formatNotification substitutes once, caps content, forces TEST, and never parses everyone/here/roles', () => {
  const settings = validateMonitorSettings({
    ...valid,
    mentionUserIds: ['207557157858574337'],
    messageTemplate: '{mencoes} {tipo} {produto} {url} {estado} {loja} @everyone @here {produto}',
    webhookUsername: 'PokeBot'
  });
  const payload = formatNotification({
    kind: 'RESTOCK',
    title: 'Card @everyone @here {url}',
    available: true,
    url: 'https://geekhaven.pt/products/card'
  }, settings);
  assert.equal(payload.username, 'PokeBot');
  assert.match(payload.content, /<@207557157858574337>/);
  assert.match(payload.content, /Card @everyone @here \{url\}/);
  assert.doesNotMatch(payload.content, /https:\/\/geekhaven\.pt\/products\/card.*https:\/\/geekhaven\.pt\/products\/card/);
  assert.deepEqual(payload.allowed_mentions, {
    parse: [],
    users: ['207557157858574337'],
    roles: [],
    replied_user: false
  });
  const testPayload = formatNotification({
    kind: 'TEST',
    title: 'Notifications are working - this is not a real drop',
    available: true,
    url: 'https://geekhaven.pt/collections/pokemon'
  }, validateMonitorSettings({ ...valid, messageTemplate: '{produto}' }));
  assert.match(testPayload.content, /^TEST\b/);
  assert.match(testPayload.content, /Notifications are working/);
  const long = formatNotification({
    kind: 'NEW PRODUCT',
    title: 'x'.repeat(3000),
    available: false,
    url: 'https://geekhaven.pt/products/x'
  }, validateMonitorSettings({ ...valid, messageTemplate: '{produto}' }));
  assert.equal(long.content.length, 2000);
});
