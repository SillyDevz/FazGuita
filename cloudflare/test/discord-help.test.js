import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleLinksInteraction } from '../src/discord-links.js';
import { helpContent, helpEmbeds } from '../src/discord-monitor.js';

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

const COMMAND_PATHS = [
  '/links adicionar',
  '/links listar',
  '/links remover',
  '/links testar',
  '/monitor iniciar',
  '/monitor pausar',
  '/monitor estado',
  '/monitor testar',
  '/monitor marcar',
  '/monitor desmarcar',
  '/monitor mencoes',
  '/monitor mensagem',
  '/monitor repor_mensagem',
  '/monitor configurar'
];

const SECTION_TITLES = [
  'Começar e testar',
  'Gerir links',
  'Quem recebe menções',
  'Mensagem personalizada',
  'Configuração'
];

function bytesToHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function makeKeys() {
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKey = bytesToHex(new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey)));
  return { keyPair, publicKey };
}

async function signedRequest(privateKey, body, { timestamp = String(Math.floor(Date.now() / 1000)) } = {}) {
  const raw = JSON.stringify(body);
  const sig = bytesToHex(new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(timestamp + raw))));
  return new Request('https://example.test/interactions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Signature-Ed25519': sig,
      'X-Signature-Timestamp': timestamp
    },
    body: raw
  });
}

function interaction(overrides = {}) {
  return {
    type: 2,
    token: INTERACTION_TOKEN,
    application_id: APP,
    guild_id: GUILD,
    member: { permissions: '32' },
    data: { name: 'ajuda' },
    ...overrides
  };
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
  return { sql, env };
}

async function json(response) {
  return { status: response.status, body: await response.json() };
}

function validateSource(url) {
  return new URL(url).toString();
}

function helpBlob(content, embeds) {
  return [content, ...embeds.map(e => `${e.title || ''}\n${e.description || ''}`)].join('\n');
}

function embedTextBudget(embed) {
  let total = 0;
  if (embed.title) total += embed.title.length;
  if (embed.description) total += embed.description.length;
  if (embed.footer && embed.footer.text) total += embed.footer.text.length;
  if (embed.author && embed.author.name) total += embed.author.name.length;
  if (Array.isArray(embed.fields)) {
    for (const field of embed.fields) {
      if (field.name) total += field.name.length;
      if (field.value) total += field.value.length;
    }
  }
  return total;
}

test('helpContent is short intro and helpEmbeds stay within Discord limits', () => {
  const content = helpContent();
  const embeds = helpEmbeds();

  assert.ok(content.length <= 2000);
  assert.ok(embeds.length <= 10);
  assert.equal(embeds.length, 5);
  assert.deepEqual(embeds.map(e => e.title), SECTION_TITLES);

  let combined = 0;
  for (const embed of embeds) {
    assert.ok((embed.title || '').length <= 256);
    assert.ok((embed.description || '').length <= 4096);
    if (Array.isArray(embed.fields)) {
      for (const field of embed.fields) {
        assert.ok((field.name || '').length <= 256);
        assert.ok((field.value || '').length <= 1024);
      }
    }
    combined += embedTextBudget(embed);
  }
  assert.ok(combined <= 6000);

  const blob = helpBlob(content, embeds);
  for (const path of COMMAND_PATHS) {
    assert.match(blob, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(blob, /continente\.pt\/pesquisa\/\?q=pokemon\+tcg&start=0&srule=Continente&pmin=0\.01/);
  assert.match(blob, /\{mencoes\} \{tipo\}: \{produto\} — \{url\}/);
  assert.match(blob, /\{estado\}/);
  assert.match(blob, /\{loja\}/);
  assert.match(blob, /Intervalo de verificação \(segundos\)/);
  assert.match(blob, /Palavras-chave de inclusão/);
  assert.match(blob, /Alertar reposições/);
  assert.match(blob, /Alertar novos produtos/);
  assert.match(blob, /Alertar listagens esgotadas/);
  assert.match(blob, /Palavras-chave de exclusão/);
  assert.match(blob, /Nome do webhook/);
  assert.match(blob, /limpar/);
  assert.match(blob, /sem menções gerais/i);
  assert.equal(/@everyone/.test(blob), false);
  assert.equal(/(^|[^`])@here\b/.test(blob), false);
  assert.equal(/\|\s*pausar/.test(blob), false);
  assert.match(blob, /amigo/);
  assert.match(blob, /texto de exemplo/i);
  assert.match(blob, /não escrevas esse texto/i);
  assert.match(blob, /Entre 60 e 3600 segundos/);
  assert.match(blob, /true.*=.*ligar/i);
  assert.match(blob, /false.*=.*desligar/i);
  assert.match(blob, /abre a loja e verifica os produtos e o stock/);
  assert.equal(/\(canónico\)|\(baseline\)|placeholder à letra|limites duros|limites habituais|só valida a URL/.test(blob), false);
});

test('ajuda handler returns embeds immediately without DB fetch or waitUntil', async () => {
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
      await signedRequest(keyPair.privateKey, interaction()),
      env, DEFAULTS, validateSource, services
    ));

    assert.equal(res.status, 200);
    assert.equal(res.body.type, 4);
    assert.equal(res.body.data.flags, 64);
    assert.deepEqual(res.body.data.allowed_mentions, { parse: [] });
    assert.equal(res.body.data.content, helpContent());
    assert.deepEqual(res.body.data.embeds, helpEmbeds());
    assert.equal(waitUntilCalls, 0);
    assert.equal(fetcherCalls, 0);
    assert.equal(dbCalls, 0);

    const blob = helpBlob(res.body.data.content, res.body.data.embeds);
    for (const title of SECTION_TITLES) assert.match(blob, new RegExp(title));
    for (const path of COMMAND_PATHS) {
      assert.match(blob, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  } finally {
    x.sql.close();
  }
});
