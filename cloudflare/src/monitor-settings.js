export const DEFAULT_MESSAGE_TEMPLATE = '{mencoes}';

const CAS_RETRIES = 5;
const MAX_KEYWORDS = 20;
const MAX_KEYWORD_LEN = 100;
const MAX_MENTIONS = 20;
const MIN_SNOWFLAKE = 17;
const MAX_SNOWFLAKE = 20;
const MIN_INTERVAL = 60;
const MAX_INTERVAL = 3600;
const MAX_TEMPLATE = 1500;
const MAX_USERNAME = 80;
const MAX_CONTENT = 2000;
const DEFAULT_MENTION = '207557157858574337';
const ALLOWED_PLACEHOLDERS = new Set(['mencoes', 'tipo', 'produto', 'url', 'estado', 'loja']);
const BOOL_KEYS = new Set(['enabled', 'alertOnNewProducts', 'alertOnRestocks', 'alertOnSoldOutListings']);
const KEYWORD_KEYS = new Set(['includeKeywords', 'excludeKeywords']);
const NORMALIZE_KEYS = new Set([
  'enabled', 'alertOnNewProducts', 'alertOnRestocks', 'alertOnSoldOutListings',
  'includeKeywords', 'excludeKeywords', 'checkIntervalSeconds', 'webhookUsername'
]);

const tableReady = new WeakMap();

function defaultMentionUserIds() {
  return [DEFAULT_MENTION];
}

function pickSettings(input = {}) {
  return {
    enabled: input.enabled,
    alertOnNewProducts: input.alertOnNewProducts,
    alertOnRestocks: input.alertOnRestocks,
    alertOnSoldOutListings: input.alertOnSoldOutListings === undefined ? false : input.alertOnSoldOutListings,
    includeKeywords: input.includeKeywords === undefined ? [] : input.includeKeywords,
    excludeKeywords: input.excludeKeywords === undefined ? [] : input.excludeKeywords,
    checkIntervalSeconds: input.checkIntervalSeconds === undefined ? MIN_INTERVAL : input.checkIntervalSeconds,
    mentionUserIds: input.mentionUserIds === undefined ? defaultMentionUserIds() : input.mentionUserIds,
    messageTemplate: input.messageTemplate === undefined ? DEFAULT_MESSAGE_TEMPLATE : input.messageTemplate,
    webhookUsername: input.webhookUsername === undefined ? 'PokeBot' : input.webhookUsername
  };
}

function assertKeywords(name, value) {
  if (!Array.isArray(value) || value.length > MAX_KEYWORDS) throw new Error(`Invalid config: ${name}`);
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`Invalid config: ${name}`);
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > MAX_KEYWORD_LEN) throw new Error(`Invalid config: ${name}`);
    out.push(trimmed);
  }
  return out;
}

function assertMentions(value) {
  if (!Array.isArray(value) || value.length > MAX_MENTIONS) throw new Error('Invalid config: mentionUserIds');
  const out = [];
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== 'string' || !/^\d+$/.test(id) || id.length < MIN_SNOWFLAKE || id.length > MAX_SNOWFLAKE) {
      throw new Error('Invalid config: mentionUserIds');
    }
    if (seen.has(id)) throw new Error('Invalid config: mentionUserIds');
    seen.add(id);
    out.push(id);
  }
  return out;
}

function assertTemplate(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_TEMPLATE) {
    throw new Error('Invalid config: messageTemplate');
  }
  for (const match of value.matchAll(/\{([^}]*)\}/g)) {
    if (!ALLOWED_PLACEHOLDERS.has(match[1])) throw new Error('Invalid config: messageTemplate');
  }
  return value;
}

function assertUsername(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_USERNAME) {
    throw new Error('Invalid config: webhookUsername');
  }
  return value;
}

function assertInterval(value) {
  if (!Number.isInteger(value) || value < MIN_INTERVAL || value > MAX_INTERVAL) {
    throw new Error('Invalid config: checkIntervalSeconds');
  }
  return value;
}

export function validateMonitorSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid config: settings');
  for (const key of BOOL_KEYS) {
    if (typeof settings[key] !== 'boolean') throw new Error(`Invalid config: ${key}`);
  }
  return {
    enabled: settings.enabled,
    alertOnNewProducts: settings.alertOnNewProducts,
    alertOnRestocks: settings.alertOnRestocks,
    alertOnSoldOutListings: settings.alertOnSoldOutListings,
    includeKeywords: assertKeywords('includeKeywords', settings.includeKeywords),
    excludeKeywords: assertKeywords('excludeKeywords', settings.excludeKeywords),
    checkIntervalSeconds: assertInterval(settings.checkIntervalSeconds),
    mentionUserIds: assertMentions(settings.mentionUserIds),
    messageTemplate: assertTemplate(settings.messageTemplate),
    webhookUsername: assertUsername(settings.webhookUsername)
  };
}

function mergeSettings(stored, defaults) {
  const base = pickSettings(defaults);
  const raw = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  return validateMonitorSettings({
    enabled: raw.enabled === undefined ? base.enabled : raw.enabled,
    alertOnNewProducts: raw.alertOnNewProducts === undefined ? base.alertOnNewProducts : raw.alertOnNewProducts,
    alertOnRestocks: raw.alertOnRestocks === undefined ? base.alertOnRestocks : raw.alertOnRestocks,
    alertOnSoldOutListings: raw.alertOnSoldOutListings === undefined ? base.alertOnSoldOutListings : raw.alertOnSoldOutListings,
    includeKeywords: raw.includeKeywords === undefined ? base.includeKeywords : raw.includeKeywords,
    excludeKeywords: raw.excludeKeywords === undefined ? base.excludeKeywords : raw.excludeKeywords,
    checkIntervalSeconds: raw.checkIntervalSeconds === undefined ? base.checkIntervalSeconds : raw.checkIntervalSeconds,
    mentionUserIds: raw.mentionUserIds === undefined ? base.mentionUserIds : raw.mentionUserIds,
    messageTemplate: raw.messageTemplate === undefined ? base.messageTemplate : raw.messageTemplate,
    webhookUsername: raw.webhookUsername === undefined ? base.webhookUsername : raw.webhookUsername
  });
}

export function normalizeSetting(name, value) {
  if (!NORMALIZE_KEYS.has(name)) throw new Error(`Invalid config: ${name}`);
  if (BOOL_KEYS.has(name)) {
    if (value !== true && value !== false) throw new Error(`Invalid config: ${name}`);
    return value;
  }
  if (KEYWORD_KEYS.has(name)) {
    if (typeof value === 'string') {
      if (value.trim().toLowerCase() === 'limpar') return [];
      const parts = value.split(',').map(part => part.trim()).filter(Boolean);
      return assertKeywords(name, parts);
    }
    return assertKeywords(name, value);
  }
  if (name === 'checkIntervalSeconds') {
    const n = typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value.trim()) : value;
    return assertInterval(n);
  }
  if (name === 'webhookUsername') return assertUsername(value);
  throw new Error(`Invalid config: ${name}`);
}

async function ensureMonitorSettingsTable(db) {
  let pending = tableReady.get(db);
  if (!pending) {
    pending = Promise.resolve(db.prepare(
      `CREATE TABLE IF NOT EXISTS monitor_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        settings TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0
      )`
    ).run()).then(() => undefined).catch(err => {
      tableReady.delete(db);
      throw err;
    });
    tableReady.set(db, pending);
  }
  await pending;
}

function seedFrom(defaults) {
  return validateMonitorSettings(pickSettings(defaults));
}

export async function getMonitorSettings(env, defaults) {
  await ensureMonitorSettingsTable(env.DB);
  const seed = seedFrom(defaults);
  await env.DB.prepare('INSERT OR IGNORE INTO monitor_settings (id, settings, version) VALUES (1, ?, 0)')
    .bind(JSON.stringify(seed)).run();
  const row = await env.DB.prepare('SELECT settings FROM monitor_settings WHERE id = 1').first();
  return mergeSettings(JSON.parse(row.settings), seed);
}

export async function updateMonitorSettings(env, defaults, mutator) {
  await ensureMonitorSettingsTable(env.DB);
  const seed = seedFrom(defaults);
  await env.DB.prepare('INSERT OR IGNORE INTO monitor_settings (id, settings, version) VALUES (1, ?, 0)')
    .bind(JSON.stringify(seed)).run();
  for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
    const row = await env.DB.prepare('SELECT settings, version FROM monitor_settings WHERE id = 1').first();
    const current = mergeSettings(JSON.parse(row.settings), seed);
    const next = mutator(current);
    const validated = validateMonitorSettings(next);
    const result = await env.DB.prepare(
      'UPDATE monitor_settings SET settings = ?, version = version + 1 WHERE id = 1 AND version = ?'
    ).bind(JSON.stringify(validated), row.version).run();
    if (result.meta.changes === 1) return validated;
  }
  throw new Error('monitor_settings conflict');
}

export function formatNotification(event, settings) {
  const s = validateMonitorSettings(settings);
  let loja = '';
  try { loja = new URL(event.url).hostname; } catch { /* keep empty */ }
  const values = {
    mencoes: s.mentionUserIds.map(id => `<@${id}>`).join(' '),
    tipo: String(event.kind ?? ''),
    produto: String(event.title ?? ''),
    url: String(event.url ?? ''),
    estado: event.available ? 'In stock' : 'Sold out',
    loja
  };
  let content = s.messageTemplate.replace(/\{(mencoes|tipo|produto|url|estado|loja)\}/g, (_, key) => values[key]);
  if (event.kind === 'TEST' && !/(^|[\s:])TEST([\s:]|$)/.test(content)) {
    content = content ? `TEST ${content}` : 'TEST';
  }
  if (content.length > MAX_CONTENT) content = content.slice(0, MAX_CONTENT);
  return {
    username: s.webhookUsername,
    content,
    allowed_mentions: {
      parse: [],
      users: [...s.mentionUserIds],
      roles: [],
      replied_user: false
    }
  };
}
