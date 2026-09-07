#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

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
    }
  ]
};

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

export async function main(argv = process.argv.slice(2), env = process.env, fetcher = fetch) {
  const apply = argv.includes('--apply');
  let request;
  try {
    request = registrationRequest(env, { requireBotToken: apply });
  } catch {
    console.error(apply
      ? 'Missing or invalid DISCORD_APPLICATION_ID, DISCORD_GUILD_ID, or DISCORD_BOT_TOKEN'
      : 'Missing or invalid DISCORD_APPLICATION_ID or DISCORD_GUILD_ID');
    process.exitCode = 1;
    return;
  }
  if (!apply) {
    console.log(JSON.stringify({ dryRun: true, method: request.method, url: request.url, body: request.body }, null, 2));
    return;
  }
  let response;
  try {
    response = await fetcher(request.url, {
      method: request.method,
      headers: {
        Authorization: `Bot ${requireToken(env)}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(request.body)
    });
  } catch {
    console.error('Discord command registration failed');
    process.exitCode = 1;
    return;
  }
  if (!response.ok) {
    console.error('Discord command registration failed');
    process.exitCode = 1;
    return;
  }
  console.log('Registered /links guild command');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
