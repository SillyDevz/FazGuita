import { handleMonitorSubcommand, helpContent } from './discord-monitor.js';

const MAX_SOURCES = 20;
const MAX_CONTENT = 2000;
const SIG_WINDOW_SEC = 300;
const CAS_RETRIES = 5;
const MANAGE_GUILD = 32n;
const ADMINISTRATOR = 8n;
const DIAGNOSTICS_VERSION = '1';
const DIAG_EVENT = 'discord_verification';
const FOLLOWUP_EVENT = 'discord_followup';
const WEB_CRYPTO_ERROR_NAMES = new Set([
  'DataError',
  'OperationError',
  'NotSupportedError',
  'InvalidAccessError',
  'TypeError',
  'QuotaExceededError',
  'SyntaxError'
]);

function hexToBytes(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function ephemeral(content) {
  const text = content.length > MAX_CONTENT ? content.slice(0, MAX_CONTENT) : content;
  return Response.json({ type: 4, data: { content: text, flags: 64, allowed_mentions: { parse: [] } } });
}

function deferredEphemeral() {
  return Response.json({ type: 5, data: { flags: 64 } });
}

function typeCategory(value) {
  if (value === null) return 'null';
  return typeof value;
}

function sanitizeErrorName(err) {
  const name = err && typeof err.name === 'string' ? err.name : 'unknown';
  return WEB_CRYPTO_ERROR_NAMES.has(name) ? name : 'unknown';
}

function boundInt(n, max = 10_000_000) {
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(0, Math.floor(n)), max);
}

function isValidHex(value) {
  return typeof value === 'string' && /^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0;
}

function keyMetadata(publicKeyHex) {
  const meta = {
    key_present: publicKeyHex != null && publicKeyHex !== '',
    key_type: typeCategory(publicKeyHex),
    key_char_count: null,
    key_valid_hex: false,
    key_decoded_byte_count: null,
    key_leading_trailing_whitespace: false,
    key_surrounding_quotes: false
  };
  if (typeof publicKeyHex !== 'string') return meta;
  meta.key_char_count = boundInt(publicKeyHex.length, 10_000);
  meta.key_leading_trailing_whitespace = publicKeyHex.length > 0 && publicKeyHex !== publicKeyHex.trim();
  meta.key_surrounding_quotes = publicKeyHex.length >= 2 && (
    (publicKeyHex.startsWith('"') && publicKeyHex.endsWith('"')) ||
    (publicKeyHex.startsWith("'") && publicKeyHex.endsWith("'"))
  );
  meta.key_valid_hex = isValidHex(publicKeyHex);
  meta.key_decoded_byte_count = meta.key_valid_hex ? boundInt(publicKeyHex.length / 2, 10_000) : null;
  return meta;
}

function signatureMetadata(signatureHex, base = {}) {
  const meta = {
    ...base,
    signature_present: signatureHex != null && signatureHex !== '',
    signature_char_count: null,
    signature_valid_hex: false,
    signature_decoded_byte_count: null
  };
  if (typeof signatureHex !== 'string') return meta;
  meta.signature_char_count = boundInt(signatureHex.length, 10_000);
  meta.signature_valid_hex = isValidHex(signatureHex);
  meta.signature_decoded_byte_count = meta.signature_valid_hex ? boundInt(signatureHex.length / 2, 10_000) : null;
  return meta;
}

function emitDiagnostic(level, record) {
  try {
    const line = JSON.stringify(record);
    if (level === 'warn') console.warn(line);
    else console.info(line);
  } catch {
    /* logging must never break the request */
  }
}

async function verifyDiscordRequest(request, publicKeyHex) {
  const diagnostic_id = crypto.randomUUID();
  const started = Date.now();

  const stamp = () => ({
    event: DIAG_EVENT,
    diagnostics_version: DIAGNOSTICS_VERSION,
    diagnostic_id,
    elapsed_ms: boundInt(Date.now() - started, 600_000),
    allowed_window_sec: SIG_WINDOW_SEC
  });

  const fail = (reason, stage, extra = {}) => {
    emitDiagnostic('warn', {
      ...stamp(),
      outcome: 'failure',
      reason,
      stage,
      http_status: 401,
      ...extra
    });
    return { body: null, diagnostic_id };
  };

  const keyMeta = keyMetadata(publicKeyHex);
  if (publicKeyHex == null || publicKeyHex === '') {
    return fail('public_key_missing', 'public_key', keyMeta);
  }
  if (typeof publicKeyHex !== 'string') {
    return fail('public_key_type', 'public_key', keyMeta);
  }
  if (!keyMeta.key_valid_hex) {
    return fail('public_key_invalid_hex', 'public_key', keyMeta);
  }
  if (keyMeta.key_decoded_byte_count !== 32) {
    return fail('public_key_invalid_length', 'public_key', keyMeta);
  }
  const keyBytes = hexToBytes(publicKeyHex);

  const signatureHex = request.headers.get('X-Signature-Ed25519');
  const sigMeta = signatureMetadata(signatureHex, keyMeta);
  if (signatureHex == null || signatureHex === '') {
    return fail('signature_missing', 'signature', sigMeta);
  }
  if (!sigMeta.signature_valid_hex) {
    return fail('signature_invalid_hex', 'signature', sigMeta);
  }
  if (sigMeta.signature_decoded_byte_count !== 64) {
    return fail('signature_invalid_length', 'signature', sigMeta);
  }
  const sigBytes = hexToBytes(signatureHex);

  const timestamp = request.headers.get('X-Signature-Timestamp');
  const tsMeta = {
    ...sigMeta,
    timestamp_present: timestamp != null && timestamp !== '',
    timestamp_valid_format: typeof timestamp === 'string' && /^\d+$/.test(timestamp),
    timestamp_age_seconds: null
  };
  if (timestamp == null || timestamp === '') {
    return fail('timestamp_missing', 'timestamp', tsMeta);
  }
  if (!tsMeta.timestamp_valid_format) {
    return fail('timestamp_invalid_format', 'timestamp', tsMeta);
  }
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  tsMeta.timestamp_age_seconds = boundInt(age, 1_000_000_000);
  if (age > SIG_WINDOW_SEC) {
    return fail('timestamp_outside_window', 'timestamp', tsMeta);
  }

  let body;
  try {
    body = await request.text();
  } catch (err) {
    return fail('body_read_failed', 'body', {
      ...tsMeta,
      error_name: sanitizeErrorName(err)
    });
  }

  const bodyMeta = {
    ...tsMeta,
    body_utf8_byte_count: boundInt(new TextEncoder().encode(body).length, 10_000_000),
    crypto_import_ok: false,
    crypto_verify_completed: false
  };

  let key;
  try {
    key = await crypto.subtle.importKey('raw', keyBytes, { name: 'Ed25519' }, false, ['verify']);
    bodyMeta.crypto_import_ok = true;
  } catch (err) {
    return fail('public_key_import_failed', 'import', {
      ...bodyMeta,
      error_name: sanitizeErrorName(err)
    });
  }

  let verified;
  try {
    verified = await crypto.subtle.verify('Ed25519', key, sigBytes, new TextEncoder().encode(timestamp + body));
    bodyMeta.crypto_verify_completed = true;
  } catch (err) {
    return fail('signature_verify_failed', 'verify', {
      ...bodyMeta,
      error_name: sanitizeErrorName(err)
    });
  }

  if (!verified) {
    return fail('signature_mismatch', 'verify', bodyMeta);
  }

  emitDiagnostic('info', {
    ...stamp(),
    outcome: 'success',
    reason: 'signature_ok',
    stage: 'verify',
    ...bodyMeta
  });
  return { body, diagnostic_id };
}

function parseSourcesJson(raw) {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some(v => typeof v !== 'string')) throw new Error('Invalid source_config');
  return parsed;
}

export async function getSources(env, defaults) {
  const row = await env.DB.prepare('SELECT sources FROM source_config WHERE id = 1').first();
  if (!row) return [...defaults];
  return parseSourcesJson(row.sources);
}

async function mutateSources(env, defaults, mutate) {
  const defaultsJson = JSON.stringify([...defaults]);
  await env.DB.prepare('INSERT OR IGNORE INTO source_config (id, sources, version) VALUES (1, ?, 0)').bind(defaultsJson).run();
  for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
    const row = await env.DB.prepare('SELECT sources, version FROM source_config WHERE id = 1').first();
    const current = parseSourcesJson(row.sources);
    const version = row.version;
    const next = mutate(current);
    if (next === current || (Array.isArray(next) && next.length === current.length && next.every((u, i) => u === current[i]))) {
      return { sources: current, changed: false };
    }
    const result = await env.DB.prepare('UPDATE source_config SET sources = ?, version = version + 1 WHERE id = 1 AND version = ?')
      .bind(JSON.stringify(next), version).run();
    if (result.meta.changes === 1) return { sources: next, changed: true };
  }
  throw new Error('source_config conflict');
}

function hasGuildManagePermission(member) {
  if (!member || typeof member.permissions !== 'string' || !/^\d+$/.test(member.permissions)) return false;
  try {
    const bits = BigInt(member.permissions);
    return (bits & MANAGE_GUILD) === MANAGE_GUILD || (bits & ADMINISTRATOR) === ADMINISTRATOR;
  } catch {
    return false;
  }
}

function commandSub(data, commandName) {
  if (!data || data.name !== commandName || !Array.isArray(data.options) || data.options.length !== 1) return null;
  const sub = data.options[0];
  if (!sub || typeof sub.name !== 'string' || sub.type !== 1) return null;
  return sub;
}

function optionUrl(sub) {
  if (!Array.isArray(sub.options) || sub.options.length !== 1) return null;
  const opt = sub.options[0];
  if (!opt || opt.name !== 'url' || opt.type !== 3 || typeof opt.value !== 'string') return null;
  return opt.value;
}

function formatList(sources) {
  if (!sources.length) return 'Nenhuma fonte configurada.';
  const header = `Fontes (${sources.length}):\n`;
  const lines = sources.map((url, i) => `${i + 1}. ${url}`);
  let body = '';
  let shown = 0;
  for (const line of lines) {
    const next = body ? `${body}\n${line}` : line;
    const remaining = sources.length - (shown + 1);
    const suffix = remaining > 0 ? `\n... e mais ${remaining}` : '';
    if (header.length + next.length + suffix.length > MAX_CONTENT) {
      const truncated = `${header}${body}${body ? '\n' : ''}... e mais ${sources.length - shown}`;
      return truncated.slice(0, MAX_CONTENT);
    }
    body = next;
    shown += 1;
  }
  return `${header}${body}`;
}

function postVerifyDiagnostic(diagnostic_id, reason, stage, http_status, level = 'warn') {
  emitDiagnostic(level, {
    event: DIAG_EVENT,
    diagnostics_version: DIAGNOSTICS_VERSION,
    diagnostic_id,
    outcome: reason === 'ping_ok' ? 'success' : 'failure',
    reason,
    stage,
    http_status
  });
}

function isValidInteractionToken(token) {
  return typeof token === 'string' && token.length >= 10 && token.length <= 512 && /^[A-Za-z0-9._-]+$/.test(token);
}

function isValidApplicationSnowflake(id) {
  return typeof id === 'string' && /^\d{17,20}$/.test(id);
}

const FOLLOWUP_BUDGET_MS = 8000;
const FOLLOWUP_RETRY_MAX_MS = 2000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryAfterMs(response) {
  const header = response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('Retry-After')
    : null;
  if (header && /^\d+(\.\d+)?$/.test(header)) {
    const ms = Number(header) * 1000;
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }
  return null;
}

function followupFail(reason, http_status) {
  const record = {
    event: FOLLOWUP_EVENT,
    outcome: 'failure',
    reason,
    stage: 'followup'
  };
  if (http_status != null) record.http_status = boundInt(http_status, 599);
  emitDiagnostic('warn', record);
}

async function patchOriginalResponse(fetcher, applicationId, token, content) {
  const text = content.length > MAX_CONTENT ? content.slice(0, MAX_CONTENT) : content;
  const url = `https://discord.com/api/v10/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(token)}/messages/@original`;
  const body = JSON.stringify({ content: text, allowed_mentions: { parse: [] } });
  const deadline = Date.now() + FOLLOWUP_BUDGET_MS;

  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < 50) {
      followupFail('patch_budget_exhausted');
      return;
    }

    let response;
    try {
      response = await fetcher(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(remaining),
        redirect: 'error'
      });
    } catch {
      followupFail('patch_network_error');
      return;
    }

    if (response.ok) {
      try { await response.arrayBuffer(); } catch { /* ignore */ }
      return;
    }

    if (response.status === 429 && attempt === 0) {
      try { await response.arrayBuffer(); } catch { /* ignore */ }
      const retryMs = parseRetryAfterMs(response);
      const waitMs = retryMs == null ? 250 : retryMs;
      const left = deadline - Date.now();
      if (waitMs > FOLLOWUP_RETRY_MAX_MS || waitMs > left - 50) {
        followupFail('patch_failed', 429);
        return;
      }
      await sleep(waitMs);
      continue;
    }

    followupFail('patch_failed', response.status);
    return;
  }
}

function formatSourceTestResult(result, canonical) {
  const url = result && typeof result.url === 'string' && result.url ? result.url : canonical;
  const products = boundInt(Number(result?.products), 1_000_000) ?? 0;
  const available = boundInt(Number(result?.available), 1_000_000) ?? 0;
  const unavailable = boundInt(Number(result?.unavailable), 1_000_000) ?? 0;
  const unknown = boundInt(Number(result?.unknown), 1_000_000) ?? 0;
  return [
    `Teste de fonte (só leitura): ${url}`,
    `Produtos: ${products}; disponíveis: ${available}; indisponíveis: ${unavailable}; desconhecidos: ${unknown}.`,
    'Nota: não garante stock posterior.'
  ].join('\n').slice(0, MAX_CONTENT);
}

async function runLinksSubcommand(sub, env, defaults, validateSource, services) {
  if (sub.name === 'listar') {
    if (sub.options && sub.options.length) return 'Não foi possível processar o pedido.';
    return formatList(await getSources(env, defaults));
  }

  if (sub.name === 'adicionar' || sub.name === 'remover') {
    const rawUrl = optionUrl(sub);
    if (rawUrl === null) return 'Não foi possível processar o pedido.';
    let canonical;
    try { canonical = validateSource(rawUrl); } catch { return 'URL inválida.'; }
    if (typeof canonical !== 'string' || !canonical) return 'URL inválida.';

    if (sub.name === 'adicionar') {
      const result = await mutateSources(env, defaults, current => {
        if (current.includes(canonical)) return current;
        if (current.length >= MAX_SOURCES) {
          const err = new Error('max');
          err.code = 'max';
          throw err;
        }
        return [...current, canonical];
      }).catch(err => {
        if (err && err.code === 'max') return { sources: null, changed: false, max: true };
        throw err;
      });
      if (result.max) return 'Limite de 20 fontes atingido.';
      if (!result.changed) return `A fonte já estava na lista: ${canonical}`;
      return `Fonte adicionada: ${canonical}`;
    }

    const result = await mutateSources(env, defaults, current => {
      if (!current.includes(canonical)) return current;
      return current.filter(url => url !== canonical);
    });
    if (!result.changed) return `A fonte não estava na lista: ${canonical}`;
    return `Fonte removida: ${canonical}`;
  }

  if (sub.name === 'testar') {
    const rawUrl = optionUrl(sub);
    if (rawUrl === null) return 'Não foi possível processar o pedido.';
    let canonical;
    try { canonical = validateSource(rawUrl); } catch { return 'URL inválida.'; }
    if (typeof canonical !== 'string' || !canonical) return 'URL inválida.';
    if (typeof services.testSource !== 'function') return 'Não foi possível testar a fonte.';
    try {
      const result = await services.testSource(rawUrl);
      return formatSourceTestResult(result, canonical);
    } catch (err) {
      const name = err && typeof err.name === 'string' ? err.name : '';
      const code = err && typeof err.code === 'string' ? err.code : '';
      const message = err && typeof err.message === 'string' ? err.message : '';
      if (
        name === 'TimeoutError' ||
        name === 'AbortError' ||
        code === 'timeout' ||
        code === 'TIMEOUT' ||
        message === 'Request or processing failed'
      ) {
        return 'Não foi possível concluir o teste da fonte.';
      }
      return 'Não foi possível testar a fonte.';
    }
  }

  return 'Não foi possível processar o pedido.';
}

async function runAuthorizedWork(interaction, env, defaults, validateSource, services) {
  const name = interaction.data && interaction.data.name;

  if (name === 'ajuda') {
    if (interaction.data.options && interaction.data.options.length) return 'Não foi possível processar o pedido.';
    return helpContent();
  }

  if (name === 'links') {
    const sub = commandSub(interaction.data, 'links');
    if (!sub) return 'Não foi possível processar o pedido.';
    return runLinksSubcommand(sub, env, defaults, validateSource, services);
  }

  if (name === 'monitor') {
    const sub = commandSub(interaction.data, 'monitor');
    if (!sub) return 'Não foi possível processar o pedido.';
    return handleMonitorSubcommand(sub, interaction, env, services);
  }

  return 'Não foi possível processar o pedido.';
}

async function respondAuthorized(interaction, env, defaults, validateSource, services) {
  const work = () => runAuthorizedWork(interaction, env, defaults, validateSource, services);

  if (typeof services.waitUntil !== 'function') {
    try {
      return ephemeral(await work());
    } catch {
      return ephemeral('Não foi possível processar o pedido.');
    }
  }

  const token = interaction.token;
  const applicationId = env.DISCORD_APPLICATION_ID;
  if (!isValidInteractionToken(token) || !isValidApplicationSnowflake(applicationId)) {
    return ephemeral('Não foi possível processar o pedido.');
  }

  const fetcher = typeof services.fetcher === 'function' ? services.fetcher : fetch;
  services.waitUntil((async () => {
    let content;
    try {
      content = await work();
    } catch {
      content = 'Não foi possível processar o pedido.';
    }
    if (typeof content !== 'string') content = 'Não foi possível processar o pedido.';
    await patchOriginalResponse(fetcher, applicationId, token, content);
  })());

  return deferredEphemeral();
}

export async function handleLinksInteraction(request, env, defaults, validateSource, services = {}) {
  try {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const { body, diagnostic_id } = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
    if (body === null) return new Response('Invalid request signature', { status: 401 });

    let interaction;
    try { interaction = JSON.parse(body); } catch {
      postVerifyDiagnostic(diagnostic_id, 'body_invalid_json', 'parse', 200);
      return ephemeral('Não foi possível processar o pedido.');
    }
    if (!interaction || typeof interaction !== 'object') {
      postVerifyDiagnostic(diagnostic_id, 'body_invalid_json', 'parse', 200);
      return ephemeral('Não foi possível processar o pedido.');
    }

    if (interaction.type === 1) {
      postVerifyDiagnostic(diagnostic_id, 'ping_ok', 'ping_response', 200, 'info');
      return Response.json({ type: 1 });
    }
    if (interaction.type !== 2) {
      postVerifyDiagnostic(diagnostic_id, 'unexpected_interaction_type', 'dispatch', 200);
      return ephemeral('Não foi possível processar o pedido.');
    }

    if (!env.DISCORD_APPLICATION_ID || !env.DISCORD_GUILD_ID) return ephemeral('Não foi possível processar o pedido.');
    if (interaction.application_id !== env.DISCORD_APPLICATION_ID) return ephemeral('Comando indisponível.');
    if (!interaction.guild_id || interaction.guild_id !== env.DISCORD_GUILD_ID) return ephemeral('Comando indisponível.');
    if (!hasGuildManagePermission(interaction.member)) return ephemeral('Sem permissão para gerir fontes.');

    return respondAuthorized(interaction, env, defaults, validateSource, services);
  } catch {
    return ephemeral('Não foi possível processar o pedido.');
  }
}
