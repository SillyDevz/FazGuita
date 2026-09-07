#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

const CONFIG_CHOICES = [
  { name: 'Alertar novos produtos', value: 'alertOnNewProducts' },
  { name: 'Alertar reposições', value: 'alertOnRestocks' },
  { name: 'Alertar listagens esgotadas', value: 'alertOnSoldOutListings' },
  { name: 'Palavras-chave de inclusão', value: 'includeKeywords' },
  { name: 'Palavras-chave de exclusão', value: 'excludeKeywords' },
  { name: 'Intervalo de verificação (segundos)', value: 'checkIntervalSeconds' },
  { name: 'Nome do webhook', value: 'webhookUsername' }
];

export const linksCommand = {
  name: 'links',
  type: 1,
  description: 'Gerir URLs de fontes monitorizadas',
  default_member_permissions: '32',
  options: [
    {
      name: 'adicionar',
      description: 'Adicionar uma fonte à lista',
      type: 1,
      options: [{ name: 'url', description: 'URL da fonte', type: 3, required: true }]
    },
    {
      name: 'listar',
      description: 'Listar fontes configuradas',
      type: 1
    },
    {
      name: 'remover',
      description: 'Remover uma fonte da lista',
      type: 1,
      options: [{ name: 'url', description: 'URL da fonte', type: 3, required: true }]
    },
    {
      name: 'testar',
      description: 'Testar uma URL suportada (só leitura)',
      type: 1,
      options: [{ name: 'url', description: 'URL da fonte', type: 3, required: true }]
    }
  ]
};

export const monitorCommand = {
  name: 'monitor',
  type: 1,
  description: 'Gerir o monitor de stock e notificações',
  default_member_permissions: '32',
  options: [
    { name: 'iniciar', description: 'Ativar o monitor', type: 1 },
    { name: 'pausar', description: 'Pausar o monitor', type: 1 },
    { name: 'estado', description: 'Ver estado e configuração', type: 1 },
    { name: 'testar', description: 'Enviar notificação de teste (mesmo pausado)', type: 1 },
    {
      name: 'marcar',
      description: 'Adicionar utilizador às menções',
      type: 1,
      options: [{ name: 'usuario', description: 'Utilizador a mencionar', type: 6, required: true }]
    },
    {
      name: 'desmarcar',
      description: 'Remover utilizador das menções',
      type: 1,
      options: [{ name: 'usuario', description: 'Utilizador a remover', type: 6, required: true }]
    },
    { name: 'mencoes', description: 'Listar utilizadores mencionados', type: 1 },
    {
      name: 'mensagem',
      description: 'Ver ou definir o modelo de mensagem',
      type: 1,
      options: [{ name: 'texto', description: 'Novo modelo (omitir para ver o atual)', type: 3, required: false }]
    },
    { name: 'repor_mensagem', description: 'Repor o modelo de mensagem predefinido', type: 1 },
    {
      name: 'configurar',
      description: 'Alterar uma opção de configuração',
      type: 1,
      options: [
        {
          name: 'opcao',
          description: 'Campo a configurar',
          type: 3,
          required: true,
          choices: CONFIG_CHOICES
        },
        { name: 'valor', description: 'Novo valor (true/false, lista, número, nome)', type: 3, required: true }
      ]
    }
  ]
};

export const helpCommand = {
  name: 'ajuda',
  type: 1,
  description: 'Mostrar ajuda dos comandos do monitor',
  default_member_permissions: '32'
};

export const commands = [linksCommand, monitorCommand, helpCommand];

function requireSnowflake(name, env = process.env) {
  const value = env[name];
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) throw new Error(`Invalid ${name}`);
  return value.trim();
}

function requireToken(env = process.env) {
  const value = env.DISCORD_BOT_TOKEN;
  if (typeof value !== 'string' || !value.trim()) throw new Error('Missing DISCORD_BOT_TOKEN');
  return value.trim();
}

export function registrationRequest(env = process.env, { requireBotToken = false } = {}) {
  const applicationId = requireSnowflake('DISCORD_APPLICATION_ID', env);
  const guildId = requireSnowflake('DISCORD_GUILD_ID', env);
  if (requireBotToken) requireToken(env);
  return {
    method: 'POST',
    url: `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`,
    body: linksCommand
  };
}

function registrationUrl(env) {
  const applicationId = requireSnowflake('DISCORD_APPLICATION_ID', env);
  const guildId = requireSnowflake('DISCORD_GUILD_ID', env);
  return `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`;
}

export async function main(argv = process.argv.slice(2), env = process.env, fetcher = fetch) {
  const apply = argv.includes('--apply');
  let url;
  try {
    if (apply) requireToken(env);
    url = registrationUrl(env);
  } catch {
    console.error(apply
      ? 'Missing or invalid DISCORD_APPLICATION_ID, DISCORD_GUILD_ID, or DISCORD_BOT_TOKEN'
      : 'Missing or invalid DISCORD_APPLICATION_ID or DISCORD_GUILD_ID');
    process.exitCode = 1;
    return;
  }

  if (!apply) {
    console.log(JSON.stringify({
      dryRun: true,
      method: 'POST',
      url,
      commands: commands.map(body => ({ name: body.name, body }))
    }, null, 2));
    return;
  }

  const token = requireToken(env);
  let failed = false;
  for (const command of commands) {
    let response;
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(command)
      });
    } catch {
      console.error(`Discord command registration failed: ${command.name}`);
      failed = true;
      continue;
    }
    if (!response.ok) {
      console.error(`Discord command registration failed: ${command.name}`);
      failed = true;
      continue;
    }
    console.log(`Registered /${command.name} guild command`);
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
