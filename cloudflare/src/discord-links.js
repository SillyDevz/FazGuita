const MAX_SOURCES = 20;
const MAX_CONTENT = 2000;
const SIG_WINDOW_SEC = 300;
const CAS_RETRIES = 5;
const MANAGE_GUILD = 32n;
const ADMINISTRATOR = 8n;

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

async function verifyDiscordRequest(request, publicKeyHex) {
  const signatureHex = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');
  const keyBytes = hexToBytes(publicKeyHex);
  const sigBytes = hexToBytes(signatureHex);
  if (!keyBytes || keyBytes.length !== 32 || !sigBytes || sigBytes.length !== 64) return null;
  if (typeof timestamp !== 'string' || !/^\d+$/.test(timestamp)) return null;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > SIG_WINDOW_SEC) return null;
  const body = await request.text();
  try {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'Ed25519' }, false, ['verify']);
    const ok = await crypto.subtle.verify('Ed25519', key, sigBytes, new TextEncoder().encode(timestamp + body));
    return ok ? body : null;
  } catch {
    return null;
  }
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

function subcommand(data) {
  if (!data || data.name !== 'links' || !Array.isArray(data.options) || data.options.length !== 1) return null;
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

export async function handleLinksInteraction(request, env, defaults, validateSource) {
  try {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const body = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
    if (body === null) return new Response('Invalid request signature', { status: 401 });

    let interaction;
    try { interaction = JSON.parse(body); } catch { return ephemeral('Não foi possível processar o pedido.'); }
    if (!interaction || typeof interaction !== 'object') return ephemeral('Não foi possível processar o pedido.');

    if (interaction.type === 1) return Response.json({ type: 1 });
    if (interaction.type !== 2) return ephemeral('Não foi possível processar o pedido.');

    if (!env.DISCORD_APPLICATION_ID || !env.DISCORD_GUILD_ID) return ephemeral('Não foi possível processar o pedido.');
    if (interaction.application_id !== env.DISCORD_APPLICATION_ID) return ephemeral('Comando indisponível.');
    if (!interaction.guild_id || interaction.guild_id !== env.DISCORD_GUILD_ID) return ephemeral('Comando indisponível.');
    if (!hasGuildManagePermission(interaction.member)) return ephemeral('Sem permissão para gerir fontes.');

    const sub = subcommand(interaction.data);
    if (!sub) return ephemeral('Não foi possível processar o pedido.');

    if (sub.name === 'listar') {
      if (sub.options && sub.options.length) return ephemeral('Não foi possível processar o pedido.');
      return ephemeral(formatList(await getSources(env, defaults)));
    }

    if (sub.name === 'adicionar' || sub.name === 'remover') {
      const rawUrl = optionUrl(sub);
      if (rawUrl === null) return ephemeral('Não foi possível processar o pedido.');
      let canonical;
      try { canonical = validateSource(rawUrl); } catch { return ephemeral('URL inválida.'); }
      if (typeof canonical !== 'string' || !canonical) return ephemeral('URL inválida.');

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
        if (result.max) return ephemeral('Limite de 20 fontes atingido.');
        if (!result.changed) return ephemeral(`A fonte já estava na lista: ${canonical}`);
        return ephemeral(`Fonte adicionada: ${canonical}`);
      }

      const result = await mutateSources(env, defaults, current => {
        if (!current.includes(canonical)) return current;
        return current.filter(url => url !== canonical);
      });
      if (!result.changed) return ephemeral(`A fonte não estava na lista: ${canonical}`);
      return ephemeral(`Fonte removida: ${canonical}`);
    }

    return ephemeral('Não foi possível processar o pedido.');
  } catch {
    return ephemeral('Não foi possível processar o pedido.');
  }
}
