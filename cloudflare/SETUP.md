# Geek Haven to Discord: free Cloudflare setup

This folder contains the server version. Your Windows monitor is separate. The Worker checks once per minute, stores history and pending alerts in D1, and posts matching products to Discord. It starts paused. No domain name or always-on PC is needed after deployment.

## 1. Create the accounts and channel

Create a free Cloudflare account at https://dash.cloudflare.com/sign-up. Stay on Workers Free; do not upgrade to a paid plan for this setup.

Create a private Discord server (or use one you manage), invite your friend, and create a text channel named `pokemon-drops`. On Discord desktop/web, open Server Settings > Integrations > Webhooks > New Webhook. Select that channel, save, and copy the webhook URL. Keep the URL private: it permits posting to the channel.

On your friend's phone, install/sign in to Discord, allow notifications in Android settings, and enable mobile notifications for the server. Set the channel notification setting to All Messages and ensure it is not muted. The phone must have internet. Discord/Android control notification sound, volume and Do Not Disturb; the Windows MP3 and five-repeat setting do not transfer to Discord.

## 2. Open the project in PowerShell

On this PC, Node.js is already installed. On another computer install Node.js LTS first (https://nodejs.org/), then reopen the terminal.

```powershell
cd "$HOME\Desktop\FazGuita\cloudflare"
npm.cmd install
npm.cmd test
npx.cmd wrangler login
```

Approve the Cloudflare login in the browser. Use `.cmd` as shown to avoid PowerShell execution-policy problems with npm's PowerShell wrappers. No GitHub account is required.

## 3. Create the database

```powershell
npx.cmd wrangler d1 create geekhaven-monitor
```

Copy the `database_id` UUID printed by the command. Open `wrangler.jsonc` and replace only `REPLACE_WITH_YOUR_DATABASE_ID` with that UUID. Keep the binding name `DB`. If Wrangler offers to edit the configuration itself, check that it filled the existing DB binding rather than adding a duplicate.

Create the table in the cloud database:

```powershell
npx.cmd wrangler d1 execute geekhaven-monitor --remote --file=./schema.sql
```

Confirm the command when prompted. `CREATE TABLE IF NOT EXISTS` and `INSERT OR IGNORE` preserve existing history if repeated.

## 4. Deploy paused and add secrets

Leave `enabled` set to `false` in this folder's `config.json` for now.

```powershell
npx.cmd wrangler deploy
npx.cmd wrangler secret put DISCORD_WEBHOOK_URL
```

Paste the Discord webhook URL when Wrangler prompts. Do not put it in config.json, screenshots, or source control.

Generate an admin key and store it as a Worker secret:

```powershell
$adminToken = [guid]::NewGuid().ToString('N')
$adminToken | npx.cmd wrangler secret put ADMIN_TOKEN
```

Keep this terminal open for the following steps. The token stays in `$adminToken` for this terminal session; you can generate and upload a replacement with the same commands later.

Wrangler prints the deployed Worker URL, similar to `https://geekhaven-monitor.YOUR-SUBDOMAIN.workers.dev`. Copy your actual URL:

```powershell
$workerUrl = 'https://geekhaven-monitor.YOUR-SUBDOMAIN.workers.dev'
$headers = @{ Authorization = "Bearer $adminToken" }
```

## 5. Test the phone notification

```powershell
Invoke-RestMethod -Method Post -Uri "$workerUrl/test" -Headers $headers
```

Expected response: `status: test sent`. Discord receives a clearly labeled TEST message. This does not request the store or change product history. Check that your friend's phone receives the notification too. If the message arrives but the phone does not notify, fix Discord/Android notification settings before continuing.

## 6. Start monitoring

In this folder's `config.json`, change `enabled` to `true`. The default settings alert for new products, restocks, and sold-out new listings. Empty keyword arrays match all names.

```powershell
npx.cmd wrangler deploy
Invoke-RestMethod -Method Post -Uri "$workerUrl/check" -Headers $headers
Invoke-RestMethod -Uri "$workerUrl/status" -Headers $headers
```

The first successful check silently saves existing products as the baseline. Expect `initialized: true` and a product count, with no real drop messages. If cron already performed that first check, `/check` can return `waiting`; `/status` should still show the baseline. `lastCheck` and `nextCheck` are Unix timestamps in milliseconds.

The cron runs every minute. Initial cron changes can take up to 15 minutes to propagate. Check logs while waiting:

```powershell
npx.cmd wrangler tail
```

Look for repeated `status: ok` entries. `paused` means `enabled` is false; `error` means inspect `/status`. Ctrl+C stops viewing logs; it does NOT stop the deployed monitor. After successful scheduled checks and the phone test, the PC can be turned off.

## 7. Change filters or pause

Edit `cloudflare/config.json`, then run `npx.cmd wrangler deploy` to apply changes. Unlike the local Windows monitor, the cloud version bundles configuration when deployed.

```json
{
  "enabled": true,
  "alertOnNewProducts": true,
  "alertOnRestocks": true,
  "alertOnSoldOutListings": false,
  "includeKeywords": ["Booster Box", "Elite Trainer"],
  "excludeKeywords": ["JP"]
}
```

Keywords match literal substrings without case sensitivity. Any include keyword can match; exclusions win. Empty includes mean all products. All fetched products update history, even when filtered out. Already queued alerts retain the filters that matched when they were detected.

To pause, change `enabled` to `false` and deploy. This preserves history and pending alerts. To stop the minute-by-minute invocations as well, set `triggers.crons` to `[]` in wrangler.jsonc and deploy. Changing the Windows config does not change this Worker.

## Troubleshooting and limits

- `/health` only confirms that the Worker responds; `/status` and scheduled logs confirm monitoring is working.
- HTTP 429/network errors back off, respecting Retry-After. HTTP 401/403 from the store marks monitoring blocked; it does not rotate IPs or bypass restrictions. After resolving the access issue, clear only the block/error fields in the D1 console with `UPDATE monitor SET state = json_set(state, '$.blocked', json('false'), '$.nextCheck', 0, '$.failures', 0) WHERE id = 1;`.
- Discord outages keep alerts queued and retry later. Rare duplicates are possible if Discord accepts a message but its response or the following database write fails. At most five queued alerts are sent per run. While the queue is pending, store checks wait for delivery to recover.
- Pagination supports up to 2,499 products in a full scan; larger collections need a revised strategy. Conditional requests use the server ETag only when the collection fits one page.
- This runs about 1,440 scheduled invocations/day. It stores the history in one database row to keep D1 writes low. The code is intended for Workers/D1 Free, but real deployed CPU usage must be checked: Workers Free permits only 10 ms of CPU per invocation. Network wait time does not count. In Cloudflare, inspect Worker Metrics/Logs for `exceededCpu` and D1 row usage after deployment. Free quotas can stop work when exceeded; there is no uptime or delivery guarantee.
- One-minute polling is not a guaranteed one-minute notification deadline. Store caching, rate limits, scheduling and Discord/phone delivery can add delays.
- The local tests mock network responses and use SQLite for D1 operations. They verify baseline, new products/restocks, duplicates, filters, outbox retry, backoff, denial and admin authorization. They do not verify Cloudflare-region access to the store, actual CPU allowance, or your friend's phone; steps 5-6 do that.

Official references: [Discord webhooks](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks), [mobile notifications](https://support.discord.com/hc/en-us/articles/218892547--Mobile-Notifications-Settings-101), [Cloudflare cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).
