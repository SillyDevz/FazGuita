const MAX_CONTENT = 2000;
const MAX_MENTIONS = 20;
const PLACEHOLDERS = '{mencoes}, {tipo}, {produto}, {url}, {estado}, {loja}';

const CONFIG_OPTION_KEYS = new Set([
  'alertOnNewProducts',
  'alertOnRestocks',
  'alertOnSoldOutListings',
  'includeKeywords',
  'excludeKeywords',
  'checkIntervalSeconds',
  'webhookUsername'
]);

const SAFE_STATUS_ERRORS = new Set([
  'Invalid product feed',
  'Collection exceeds pagination limit',
  'Search exceeds pagination limit',
  'Request or processing failed',
  'Request or processing failed; check Worker logs'
]);

export function helpContent() {
  const text = [
    'Ajuda do monitor de stock.',
    '',
    'Começa rápido: vê o que já existe com `/links listar`, adiciona com `/links adicionar`, confirma com `/links testar`, escolhe quem recebe alertas e usa `/monitor iniciar`.',
    '',
    'As respostas de definição são privadas. Precisas de «Gerir servidor» ou «Administrador». Os cartões abaixo detalham cada área.'
  ].join('\n');
  return text.length > MAX_CONTENT ? text.slice(0, MAX_CONTENT) : text;
}

export function helpEmbeds() {
  return [
    {
      title: 'Começar e testar',
      description: [
        '**Fluxo simples**',
        '1. Vê as fontes atuais com `/links listar` (evita duplicar pesquisas parecidas).',
        '2. Adiciona uma URL HTTPS suportada, se ainda não existir.',
        '3. Confirma a fonte com teste só de leitura.',
        '4. Marca quem deve ser notificado.',
        '5. Inicia o monitor.',
        '',
        '**Exemplo de link**',
        '```',
        'https://www.continente.pt/pesquisa/?q=pokemon+tcg&start=0&srule=Continente&pmin=0.01',
        '```',
        '',
        '`/links testar url:<url>` — abre a loja e verifica os produtos e o stock, sem adicionar o link, alterar o histórico ou enviar alertas.',
        '',
        '`/monitor testar` — envia uma notificação **real de teste (TEST)** no canal (usa as menções configuradas; funciona mesmo com o monitor pausado).',
        '',
        '`/monitor iniciar` — ativa o monitor.',
        '`/monitor pausar` — pausa o monitor.',
        '`/monitor estado` — mostra o estado e a configuração.',
        '',
        'Na primeira verificação de uma fonte nova, o stock atual fica registado em silêncio. Alertas de reposição ou produtos novos só aparecem depois.'
      ].join('\n')
    },
    {
      title: 'Gerir links',
      description: [
        '**Começa por listar** o que já está configurado:',
        '',
        '```',
        '/links listar',
        '```',
        '',
        'Depois adiciona, remove ou testa com a URL completa (mesmos parâmetros = mesma fonte):',
        '',
        '```',
        '/links adicionar url:https://www.continente.pt/pesquisa/?q=pokemon+tcg&start=0&srule=Continente&pmin=0.01',
        '```',
        '',
        '```',
        '/links remover url:https://www.continente.pt/pesquisa/?q=pokemon+tcg&start=0&srule=Continente&pmin=0.01',
        '```',
        '',
        '```',
        '/links testar url:https://www.continente.pt/pesquisa/?q=pokemon+tcg&start=0&srule=Continente&pmin=0.01',
        '```',
        '',
        '`/links testar` abre a loja e verifica os produtos e o stock, sem adicionar o link nem enviar alertas. Para um aviso real no canal usa `/monitor testar`.'
      ].join('\n')
    },
    {
      title: 'Quem recebe menções',
      description: [
        'Escolhe pessoas reais no seletor de utilizadores do Discord. O texto `@amigo` abaixo é só **texto de exemplo** — escolhe o amigo certo, não escrevas esse texto.',
        '',
        '```',
        '/monitor marcar usuario:@amigo',
        '```',
        '',
        '```',
        '/monitor desmarcar usuario:@amigo',
        '```',
        '',
        '```',
        '/monitor mencoes',
        '```',
        '',
        'Só utilizadores (sem cargos). Sem menções gerais. Limite prático: até 20 pessoas.'
      ].join('\n')
    },
    {
      title: 'Mensagem personalizada',
      description: [
        '**Ver o modelo atual** (e a lista de campos):',
        '',
        '```',
        '/monitor mensagem',
        '```',
        '',
        '**Definir um modelo**',
        '',
        '```',
        '/monitor mensagem texto:{mencoes} {tipo}: {produto} — {url}',
        '```',
        '',
        '**Repor o modelo predefinido**',
        '',
        '```',
        '/monitor repor_mensagem',
        '```',
        '',
        '**Campos disponíveis**',
        '- `{mencoes}` — quem deve ser mencionado (mantém isto se quiseres pings)',
        '- `{tipo}` — tipo de alerta',
        '- `{produto}` — nome do produto',
        '- `{url}` — ligação do produto',
        '- `{estado}` — estado do stock',
        '- `{loja}` — loja / origem'
      ].join('\n')
    },
    {
      title: 'Configuração',
      description: [
        'Usa `/monitor configurar` e escolhe a opção pelo **rótulo do menu** (não precisas de escrever chaves técnicas).',
        '',
        '**Exemplos**',
        '',
        '```',
        '/monitor configurar',
        'opcao: Intervalo de verificação (segundos)',
        'valor: 120',
        '```',
        '(~2 min. Entre 60 e 3600 segundos.)',
        '',
        '```',
        '/monitor configurar',
        'opcao: Palavras-chave de inclusão',
        'valor: Booster Box, Elite Trainer',
        '```',
        'Escreve `limpar` no valor para apagar a lista de palavras-chave.',
        '',
        '```',
        '/monitor configurar',
        'opcao: Alertar reposições',
        'valor: true',
        '```',
        '`true` = ligar, `false` = desligar.',
        '',
        'Outros rótulos do menu: «Alertar novos produtos», «Alertar listagens esgotadas» (por omissão desligado), «Palavras-chave de exclusão», «Nome do webhook».',
        '',
        'As respostas de definição ficam privadas. `/monitor testar` publica no canal real. Este comando não altera segredos de segurança.'
      ].join('\n')
    }
  ];
}

function isUserSnowflake(id) {
  return typeof id === 'string' && /^\d{17,20}$/.test(id);
}

function requireExactOptions(sub, expected) {
  const opts = Array.isArray(sub.options) ? sub.options : [];
  if (opts.length !== expected.length) return null;
  if (opts.some(o => !o || typeof o.name !== 'string')) return null;
  const names = opts.map(o => o.name);
  if (new Set(names).size !== names.length) return null;
  const values = {};
  for (const exp of expected) {
    const found = opts.find(o => o.name === exp.name);
    if (!found || found.type !== exp.type) return null;
    values[exp.name] = found.value;
  }
  for (const o of opts) {
    if (!expected.some(exp => exp.name === o.name)) return null;
  }
  return values;
}

function formatMentions(ids) {
  if (!ids.length) return 'Nenhuma menção configurada.';
  const lines = ids.map((id, i) => `${i + 1}. <@${id}>`);
  const header = `Menções (${ids.length}):\n`;
  let body = '';
  for (const line of lines) {
    const next = body ? `${body}\n${line}` : line;
    if (header.length + next.length > MAX_CONTENT) break;
    body = next;
  }
  return `${header}${body}`.slice(0, MAX_CONTENT);
}

function shortUrl(url) {
  if (typeof url !== 'string' || !url) return 'fonte';
  try {
    const u = new URL(url);
    let s = `${u.hostname}${u.pathname}`.replace(/\/$/, '') || u.hostname;
    if (s.length > 64) s = `${s.slice(0, 61)}...`;
    return s;
  } catch {
    return 'fonte';
  }
}

function sanitizeStatusError(value) {
  if (typeof value !== 'string' || !value) return null;
  if (SAFE_STATUS_ERRORS.has(value)) return value;
  if (/^Store HTTP \d+$/.test(value) || /^Discord HTTP \d+$/.test(value)) return value;
  if (/^(Store HTTP|Discord HTTP|Invalid product feed|Collection exceeds|Search exceeds)/.test(value)
    && value.length <= 80
    && !/https?:/i.test(value)
    && !/[<>]/.test(value)
    && !/\n/.test(value)) {
    return value;
  }
  return 'erro';
}

function formatTs(ms) {
  if (!Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
  } catch {
    return null;
  }
}

function formatCompactSettings(settings) {
  if (!settings || typeof settings !== 'object') return ['sem definições'];
  const incl = Array.isArray(settings.includeKeywords) ? settings.includeKeywords.length : 0;
  const excl = Array.isArray(settings.excludeKeywords) ? settings.excludeKeywords.length : 0;
  const mentions = Array.isArray(settings.mentionUserIds) ? settings.mentionUserIds.length : 0;
  return [
    `alertas: new=${settings.alertOnNewProducts === true ? 'true' : 'false'} restock=${settings.alertOnRestocks === true ? 'true' : 'false'} soldout=${settings.alertOnSoldOutListings === true ? 'true' : 'false'}`,
    `keywords: incl=${incl} excl=${excl}`,
    `intervalo=${settings.checkIntervalSeconds ?? '?'}s`,
    `webhook=${typeof settings.webhookUsername === 'string' ? settings.webhookUsername : '?'}`,
    `menções=${mentions}`,
    '(modelo: /monitor mensagem)'
  ];
}

function sourceHealthLine(url, history) {
  const h = history && typeof history === 'object' ? history : {};
  const label = shortUrl(url);
  let state;
  if (h.blocked === true) state = 'bloqueada';
  else if (!h.initialized) state = 'baseline pendente';
  else if (h.lastError) state = 'erro';
  else state = 'ok';

  const bits = [`${label} — ${state}`];
  if (Number.isFinite(h.productCount)) bits.push(`produtos=${h.productCount}`);
  const lastCheck = formatTs(h.lastCheck);
  if (lastCheck) bits.push(`última=${lastCheck}`);
  const err = sanitizeStatusError(h.lastError);
  if (err) bits.push(`erro=${err}`);
  const next = formatTs(h.nextCheck);
  if (next && (h.blocked === true || h.lastError || (Number.isFinite(h.nextCheck) && h.nextCheck > Date.now()))) {
    bits.push(`retry=${next}`);
  }
  return bits.join('; ');
}

export function formatStatus(status) {
  if (!status || typeof status !== 'object') return 'Estado indisponível.';

  const enabled = status.enabled === true ? 'ativo' : 'pausado';
  const configured = Array.isArray(status.configured) ? status.configured : [];
  const pending = typeof status.pending === 'number'
    ? status.pending
    : (Array.isArray(status.pending) ? status.pending.length : 0);
  const sourcesMap = status.sources && typeof status.sources === 'object' && !Array.isArray(status.sources)
    ? status.sources
    : {};

  const header = [
    `Monitor: ${enabled}`,
    `Fontes configuradas: ${configured.length}`,
    `Pendentes: ${pending}`
  ];

  const globalError = sanitizeStatusError(status.lastError);
  if (globalError) header.push(`Erro global: ${globalError}`);
  const globalNext = formatTs(status.nextCheck);
  if (globalNext) header.push(`Próxima verificação: ${globalNext}`);

  const sourceLines = [];
  for (const url of configured) {
    sourceLines.push(sourceHealthLine(url, sourcesMap[url]));
  }

  const settingsLines = formatCompactSettings(status.settings);
  const settingsBlock = ['', 'Definições:', ...settingsLines];

  let body = header.join('\n');
  if (sourceLines.length) {
    body += '\n\nFontes:';
  }

  let shown = 0;
  for (let i = 0; i < sourceLines.length; i++) {
    const line = `${i + 1}. ${sourceLines[i]}`;
    const remaining = sourceLines.length - (shown + 1);
    const omitSuffix = remaining > 0 ? `\n... e mais ${remaining}` : '';
    const settingsBudget = `\n${settingsBlock.join('\n')}`;
    const candidate = `${body}\n${line}`;
    if (candidate.length + omitSuffix.length + settingsBudget.length > MAX_CONTENT) {
      if (shown === 0) {
        const truncated = `${body}\n${line}`.slice(0, Math.max(0, MAX_CONTENT - settingsBudget.length - 20));
        const omitted = sourceLines.length - 1;
        body = omitted > 0 ? `${truncated}\n... e mais ${omitted}` : truncated;
        shown = 1;
      } else {
        body += `\n... e mais ${sourceLines.length - shown}`;
      }
      break;
    }
    body = candidate;
    shown += 1;
    if (i === sourceLines.length - 1) {
      /* all shown */
    }
  }

  let out = `${body}\n${settingsBlock.join('\n')}`;
  if (out.length > MAX_CONTENT) out = out.slice(0, MAX_CONTENT);
  return out;
}

async function loadSettingsApi() {
  return import('./monitor-settings.js');
}

function defaultsFrom(services) {
  return services && services.settingsDefaults != null ? services.settingsDefaults : {};
}

export async function handleMonitorSubcommand(sub, interaction, env, services = {}) {
  if (!sub || typeof sub.name !== 'string') return 'Não foi possível processar o pedido.';

  let api;
  try {
    api = await loadSettingsApi();
  } catch {
    return 'Definições do monitor indisponíveis.';
  }

  const {
    getMonitorSettings,
    updateMonitorSettings,
    normalizeSetting,
    validateMonitorSettings,
    DEFAULT_MESSAGE_TEMPLATE
  } = api;

  if (typeof getMonitorSettings !== 'function' || typeof updateMonitorSettings !== 'function') {
    return 'Definições do monitor indisponíveis.';
  }

  const defaults = defaultsFrom(services);

  if (sub.name === 'iniciar' || sub.name === 'pausar') {
    if (sub.options && sub.options.length) return 'Não foi possível processar o pedido.';
    const enable = sub.name === 'iniciar';
    try {
      const settings = await updateMonitorSettings(env, defaults, current => {
        if (current.enabled === enable) return current;
        return { ...current, enabled: enable };
      });
      if (settings.enabled === enable) {
        return enable ? 'Monitor iniciado.' : 'Monitor pausado.';
      }
      return 'Não foi possível processar o pedido.';
    } catch {
      return 'Não foi possível atualizar o monitor.';
    }
  }

  if (sub.name === 'estado') {
    if (sub.options && sub.options.length) return 'Não foi possível processar o pedido.';
    if (typeof services.getStatus !== 'function') return 'Estado indisponível.';
    try {
      const status = await services.getStatus();
      return formatStatus(status);
    } catch {
      return 'Não foi possível obter o estado.';
    }
  }

  if (sub.name === 'testar') {
    if (sub.options && sub.options.length) return 'Não foi possível processar o pedido.';
    if (typeof services.sendTest !== 'function') return 'Não foi possível enviar o teste.';
    try {
      await services.sendTest();
      return 'Notificação de teste enviada.';
    } catch {
      return 'Não foi possível enviar a notificação de teste.';
    }
  }

  if (sub.name === 'mencoes') {
    if (sub.options && sub.options.length) return 'Não foi possível processar o pedido.';
    try {
      const settings = await getMonitorSettings(env, defaults);
      const ids = Array.isArray(settings.mentionUserIds) ? settings.mentionUserIds : [];
      return formatMentions(ids);
    } catch {
      return 'Não foi possível listar as menções.';
    }
  }

  if (sub.name === 'marcar' || sub.name === 'desmarcar') {
    const parsed = requireExactOptions(sub, [{ name: 'usuario', type: 6 }]);
    if (!parsed) return 'Não foi possível processar o pedido.';
    const userId = parsed.usuario;
    if (!isUserSnowflake(userId)) return 'ID de utilizador inválido.';

    if (sub.name === 'marcar') {
      const resolved = interaction?.data?.resolved?.users?.[userId];
      if (resolved && resolved.bot === true) return 'Não é possível marcar bots.';
    }

    try {
      const current = await getMonitorSettings(env, defaults);
      const existing = Array.isArray(current.mentionUserIds) ? current.mentionUserIds : [];

      if (sub.name === 'marcar') {
        if (existing.includes(userId)) return `O utilizador já estava nas menções: <@${userId}>`;
        if (existing.length >= MAX_MENTIONS) return 'Limite de 20 menções atingido.';
        await updateMonitorSettings(env, defaults, cur => {
          const ids = Array.isArray(cur.mentionUserIds) ? cur.mentionUserIds : [];
          if (ids.includes(userId)) return cur;
          if (ids.length >= MAX_MENTIONS) {
            const err = new Error('max');
            err.code = 'max';
            throw err;
          }
          return { ...cur, mentionUserIds: [...ids, userId] };
        });
        return `Utilizador marcado: <@${userId}>`;
      }

      if (!existing.includes(userId)) return `O utilizador não estava nas menções: <@${userId}>`;
      await updateMonitorSettings(env, defaults, cur => {
        const ids = Array.isArray(cur.mentionUserIds) ? cur.mentionUserIds : [];
        if (!ids.includes(userId)) return cur;
        return { ...cur, mentionUserIds: ids.filter(id => id !== userId) };
      });
      return `Utilizador desmarcado: <@${userId}>`;
    } catch (err) {
      if (err && err.code === 'max') return 'Limite de 20 menções atingido.';
      return 'Não foi possível atualizar as menções.';
    }
  }

  if (sub.name === 'mensagem') {
    const opts = Array.isArray(sub.options) ? sub.options : [];
    if (opts.length === 0) {
      try {
        const settings = await getMonitorSettings(env, defaults);
        const template = typeof settings.messageTemplate === 'string' ? settings.messageTemplate : String(DEFAULT_MESSAGE_TEMPLATE ?? '{mencoes}');
        return `Modelo atual:\n${template}\n\nPlaceholders: ${PLACEHOLDERS}`.slice(0, MAX_CONTENT);
      } catch {
        return 'Não foi possível obter o modelo de mensagem.';
      }
    }
    if (opts.length !== 1 || !opts[0] || opts[0].name !== 'texto' || opts[0].type !== 3 || typeof opts[0].value !== 'string') {
      return 'Não foi possível processar o pedido.';
    }
    const texto = opts[0].value;
    try {
      await updateMonitorSettings(env, defaults, current => {
        const next = { ...current, messageTemplate: texto };
        if (typeof validateMonitorSettings === 'function') validateMonitorSettings(next);
        return next;
      });
      return 'Modelo de mensagem atualizado.';
    } catch {
      return 'Modelo de mensagem inválido.';
    }
  }

  if (sub.name === 'repor_mensagem') {
    if (sub.options && sub.options.length) return 'Não foi possível processar o pedido.';
    try {
      const template = typeof DEFAULT_MESSAGE_TEMPLATE === 'string' ? DEFAULT_MESSAGE_TEMPLATE : '{mencoes}';
      await updateMonitorSettings(env, defaults, current => ({ ...current, messageTemplate: template }));
      return 'Modelo de mensagem reposto.';
    } catch {
      return 'Não foi possível repor o modelo de mensagem.';
    }
  }

  if (sub.name === 'configurar') {
    const parsed = requireExactOptions(sub, [
      { name: 'opcao', type: 3 },
      { name: 'valor', type: 3 }
    ]);
    if (!parsed || typeof parsed.opcao !== 'string' || typeof parsed.valor !== 'string') {
      return 'Não foi possível processar o pedido.';
    }
    const opcao = parsed.opcao;
    const valor = parsed.valor;
    if (!CONFIG_OPTION_KEYS.has(opcao)) return 'Opção de configuração desconhecida.';
    if (typeof normalizeSetting !== 'function') return 'Definições do monitor indisponíveis.';
    try {
      let raw = valor;
      if (opcao === 'alertOnNewProducts' || opcao === 'alertOnRestocks' || opcao === 'alertOnSoldOutListings') {
        if (valor === 'true') raw = true;
        else if (valor === 'false') raw = false;
      }
      const normalized = normalizeSetting(opcao, raw);
      await updateMonitorSettings(env, defaults, current => {
        const next = { ...current, [opcao]: normalized };
        if (typeof validateMonitorSettings === 'function') validateMonitorSettings(next);
        return next;
      });
      return `Opção atualizada: ${opcao}.`;
    } catch {
      return 'Valor de configuração inválido.';
    }
  }

  return 'Não foi possível processar o pedido.';
}
