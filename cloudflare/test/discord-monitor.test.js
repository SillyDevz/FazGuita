import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helpContent, formatStatus } from '../src/discord-monitor.js';

test('help content covers command syntax and stays ephemeral-sized', () => {
  const text = helpContent();
  assert.ok(text.length <= 2000);
  assert.match(text, /\/links adicionar/);
  assert.match(text, /\/links testar/);
  assert.match(text, /só leitura/);
  assert.match(text, /\/monitor iniciar/);
  assert.match(text, /\/monitor configurar/);
  assert.match(text, /limpar/);
  assert.match(text, /\{mencoes\}/);
  assert.match(text, /\{produto\}/);
  assert.match(text, /baseline silenciosa/);
  assert.match(text, /mesmo com monitor pausado/);
});

test('formatStatus shows healthy baseline and blocked source without secrets', () => {
  const healthyUrl = 'https://shop.example/collections/pokemon';
  const blockedUrl = 'https://blocked.example/collections/cards';
  const secret = 'SECRET_TOKEN_should_never_appear';

  const healthy = formatStatus({
    enabled: true,
    pending: 0,
    configured: [healthyUrl],
    sources: {
      [healthyUrl]: {
        initialized: true,
        productCount: 12,
        lastCheck: Date.parse('2026-09-07T12:00:00.000Z'),
        lastError: null,
        blocked: false,
        nextCheck: Date.parse('2026-09-07T12:01:00.000Z')
      }
    },
    settings: {
      enabled: true,
      alertOnNewProducts: true,
      alertOnRestocks: true,
      alertOnSoldOutListings: false,
      includeKeywords: Array.from({ length: 20 }, (_, i) => `kw${i}-${'x'.repeat(80)}`),
      excludeKeywords: [],
      checkIntervalSeconds: 60,
      mentionUserIds: ['207557157858574337'],
      messageTemplate: `{mencoes} ${'y'.repeat(1400)}`,
      webhookUsername: 'PokeBot'
    }
  });

  assert.match(healthy, /Monitor: ativo/);
  assert.match(healthy, /Fontes configuradas: 1/);
  assert.match(healthy, /shop\.example\/collections\/pokemon/);
  assert.match(healthy, /ok/);
  assert.match(healthy, /produtos=12/);
  assert.match(healthy, /última=2026-09-07T12:00:00Z/);
  assert.equal(/baseline pendente/.test(healthy), false);
  assert.match(healthy, /keywords: incl=20 excl=0/);
  assert.match(healthy, /\(modelo: \/monitor mensagem\)/);
  assert.equal(healthy.includes('y'.repeat(100)), false);
  assert.equal(healthy.includes('kw0-'), false);
  assert.ok(healthy.length <= 2000);

  const blocked = formatStatus({
    enabled: true,
    pending: 2,
    lastError: 'Discord HTTP 500',
    nextCheck: Date.parse('2026-09-07T12:05:00.000Z'),
    configured: [blockedUrl, healthyUrl],
    sources: {
      [blockedUrl]: {
        initialized: true,
        productCount: 3,
        blocked: true,
        lastError: 'Store HTTP 403',
        nextCheck: Date.parse('2026-09-07T13:00:00.000Z'),
        lastCheck: Date.parse('2026-09-07T11:00:00.000Z')
      },
      [healthyUrl]: {
        initialized: false,
        productCount: 0,
        blocked: false,
        lastError: null
      }
    },
    settings: {
      enabled: true,
      alertOnNewProducts: true,
      alertOnRestocks: false,
      alertOnSoldOutListings: false,
      includeKeywords: [],
      excludeKeywords: [],
      checkIntervalSeconds: 120,
      mentionUserIds: [],
      messageTemplate: '{mencoes}',
      webhookUsername: 'PokeBot'
    }
  });

  assert.match(blocked, /Monitor: ativo/);
  assert.match(blocked, /Pendentes: 2/);
  assert.match(blocked, /Erro global: Discord HTTP 500/);
  assert.match(blocked, /bloqueada/);
  assert.match(blocked, /Store HTTP 403/);
  assert.match(blocked, /baseline pendente/);
  assert.match(blocked, /blocked\.example\/collections\/cards/);
  assert.equal(blocked.includes(secret), false);

  const leaked = formatStatus({
    enabled: true,
    pending: 0,
    configured: [blockedUrl],
    lastError: `leak ${secret} https://evil.test/?tok=${secret}`,
    sources: {
      [blockedUrl]: {
        initialized: true,
        blocked: true,
        lastError: `Authorization Bearer ${secret}`,
        productCount: 1
      }
    },
    settings: SETTINGS_LIKE()
  });
  assert.match(leaked, /Erro global: erro/);
  assert.match(leaked, /erro=erro/);
  assert.equal(leaked.includes(secret), false);
  assert.equal(leaked.includes('evil.test'), false);
});

function SETTINGS_LIKE() {
  return {
    enabled: true,
    alertOnNewProducts: true,
    alertOnRestocks: true,
    alertOnSoldOutListings: false,
    includeKeywords: [],
    excludeKeywords: [],
    checkIntervalSeconds: 60,
    mentionUserIds: [],
    messageTemplate: '{mencoes}',
    webhookUsername: 'PokeBot'
  };
}
