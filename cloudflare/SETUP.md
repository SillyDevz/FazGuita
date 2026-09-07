# Cloudflare + Discord setup (new install)

This folder is the server version of FazGuita. Your Windows monitor is separate. The Worker checks about once per minute, stores history, pending alerts, sources, and runtime settings in D1, and posts matching products to Discord. Bundled `config.json` ships with `"enabled": true` for this authorized deployment — for a **new** install, set `"enabled": false` before the first deploy until secrets and schema are ready, then start with `/monitor iniciar`. No custom domain or always-on PC is required after deployment.

Already running a Worker? Use [UPGRADE.md](UPGRADE.md) instead of creating a new database.

## 1. Create the accounts and channel

Create a Cloudflare account at https://dash.cloudflare.com/sign-up. Start on Workers Free; do not enable paid billing automatically. Multi-product Continente scans may exceed Free CPU/subrequest limits; validate live metrics before relying on it. If metrics show `exceededCpu` or quota stops, reduce search scope/batching or move to an **explicitly approved** paid plan. This guide does not change plan costs for you.

Create a private Discord server (or use one you manage), invite your friend, and create a text channel named `pokemon-drops`. On Discord desktop/web, open Server Settings > Integrations > Webhooks > New Webhook. Select that channel, save, and copy the webhook URL. Keep the URL private: it permits posting to the channel.

On your friend's phone, install/sign in to Discord, allow notifications in Android settings, and enable mobile notifications for the server. Set the channel notification setting to All Messages and ensure it is not muted. The phone must have internet. Discord/Android control notification sound, volume and Do Not Disturb; the Windows MP3 and five-repeat setting do not transfer to Discord.

## 2. Open the project in PowerShell

Install **Node.js 22+** (required for `npm test`; the suite uses `node:sqlite`) from https://nodejs.org/, then reopen the terminal. Get this repo with Git clone or a ZIP extract.

```powershell
cd PATH\to\YOUR\FazGuita\cloudflare
npm.cmd install
npm.cmd test
npx.cmd wrangler login
```

Approve the Cloudflare login in the browser. Use `.cmd` as shown to avoid PowerShell execution-policy problems with npm's PowerShell wrappers. On macOS/Linux/bash, use `npm`, `npx`, and normal shell syntax instead of `npm.cmd` / `npx.cmd`.

## 3. Create the database (new installs only)

```powershell
npx.cmd wrangler d1 create geekhaven-monitor
```

Copy the `database_id` UUID printed by the command. Open `wrangler.jsonc` and set `d1_databases[0].database_id` to **that newly created UUID**. Do **not** reuse the `database_id` already committed in the repo (it belongs to another Cloudflare account’s D1). Keep the binding name `DB`, the default Worker name `site-monitor`, and the default D1 database name `geekhaven-monitor` unless you deliberately chose different names. If Wrangler offers to edit the configuration itself, check that it filled the existing DB binding rather than adding a duplicate. Do not commit real account IDs or tokens; keep local deployment values out of shared commits when they identify your account.

Create the tables in the cloud database:

```powershell
npx.cmd wrangler d1 execute geekhaven-monitor --remote --file=./schema.sql
```

Confirm the command when prompted. `CREATE TABLE IF NOT EXISTS` and `INSERT OR IGNORE` preserve existing history if repeated. Apply schema **before** deploying a build that expects `source_config`, `monitor_settings`, or the `/interactions` route. Fresh setup uses the full schema. The `monitor_settings` table is also auto-created non-destructively on first settings use, so that settings feature alone does not need a separate manual migration on an already-applied older schema that already has `monitor` / `source_config`.

## 4. Deploy paused and add secrets

For a new install, set `"enabled": false` in this folder's `config.json` before the first deploy (bundled default is `true` for the authorized existing deployment). Leave it false until webhook/admin secrets and schema are ready.

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

Keep this terminal open for the following steps. The token stays in `$adminToken` for this terminal session; you can generate and upload a replacement with the same commands later. Prefer keeping existing webhook and admin secrets when upgrading; there is no need to rotate them for a normal setup.

Wrangler prints the deployed Worker URL, similar to `https://site-monitor.YOUR-SUBDOMAIN.workers.dev`. Copy your actual URL:

```powershell
$workerUrl = 'https://site-monitor.YOUR-SUBDOMAIN.workers.dev'
$headers = @{ Authorization = "Bearer $adminToken" }
```

## 5. Test the phone notification

```powershell
Invoke-RestMethod -Method Post -Uri "$workerUrl/test" -Headers $headers
```

Expected response: `status: test sent`. Discord receives a clearly labeled **TEST** message (an actual webhook post, not a dry simulation). This does not request the store or change product history. Check that your friend's phone receives the notification too. If the message arrives but the phone does not notify, fix Discord/Android notification settings before continuing.

This step uses the admin `/test` route only. Do **not** try Discord `/monitor` or `/links` commands yet — finish **§8** (application, secrets, Interactions Endpoint, and `register:commands --apply`) first. After §8, prefer `/monitor testar` for the same real labelled TEST path using the current mentions/template (works even while paused).

## 6. Start monitoring

Runtime enablement, filters, keywords, interval, webhook username, mentions, and message template are persisted in D1 `monitor_settings` and override bundled `cloudflare/config.json` defaults after the first settings write. They survive redeploy. Sources stay on D1 `source_config` with existing semantics. Changing the Windows root config does not change this Worker.

**Chronology:** complete **§8** before any Discord `/monitor` / `/links` / `/ajuda` usage below. Until registration succeeds, use the admin HTTP fallback in this section only.

After §8 is done:

1. `/monitor iniciar` — set enabled effective true (no `/start` command).
2. `/monitor estado` — confirm per-source baseline / products / last scan / errors.
3. Optional: `/links listar`, `/links testar url:…`, `/monitor testar`, then filters/mentions/template via `/monitor configurar`, `/monitor marcar`, `/monitor mensagem`.

Without Discord registration yet, you can still force a check after setting `"enabled": true` in `config.json` and redeploying once, or use admin routes:

```powershell
npx.cmd wrangler deploy
Invoke-RestMethod -Method Post -Uri "$workerUrl/check" -Headers $headers
Invoke-RestMethod -Uri "$workerUrl/status" -Headers $headers
```

The first successful check silently saves existing products as the baseline. Expect nested per-source fields under `sources` (each with its own `initialized` / product counts), plus a `configured` URL list — not a single top-level `initialized` flag. No real drop messages should fire for that baseline. If cron already performed that first check, `/check` can return `waiting`; `/status` should still show the baseline. `lastCheck` and `nextCheck` are Unix timestamps in milliseconds when present.

Useful `/check` statuses: `paused` (effective `enabled` false), `waiting` (backoff/lease timing), `no_sources` (empty persisted list), `ok`, `blocked`, `error`. `/health` confirms the Worker responds and reports **effective** `enabled` (D1 override when present). `/status` uses dynamic settings. Pending alerts and history are preserved across pauses. Settings take effect on the next operation/check; an already-running scan or send may finish with the settings it loaded (no mid-fetch cancel or live swap). Pending alerts use current notification settings (mentions/template) for their delivery run, not a snapshot stored at detection. Filters that already queued an alert are not re-evaluated retroactively.

The cron runs every minute. `checkIntervalSeconds` (60–3600, via `/monitor configurar`) is an approximate spacing hint — cron still fires once per minute and backoff can delay further. Initial cron changes can take up to 15 minutes to propagate. Check logs while waiting:

```powershell
npx.cmd wrangler tail
```

Look for repeated `status: ok` entries. `paused` means effective `enabled` is false; `error` means inspect `/status`. Ctrl+C stops viewing logs; it does NOT stop the deployed monitor. After successful scheduled checks and the phone test, the PC can be turned off.

### Suggested Discord testing sequence (only after §8)

1. `/links listar` then `/links testar url:<supported SOURCE>` — real fetch + strict parser; allowed while paused; does not add the source, change state, or send notifications.
2. `/monitor testar` — real labelled **TEST** webhook post with current tags/template (not restock proof).
3. `/monitor iniciar`.
4. `/monitor estado` — confirm per-source baseline / product count / last scan / errors.

These steps do not prove checkout stock, account/variant/store availability, or phone notification delivery.

## 7. Change filters, mentions, template, or pause

Sources, filters, tags, message template, and other runtime settings apply **without redeploy** via Discord (section 8). Infrastructure secrets, cron triggers, and hard caps remain deploy/dashboard concerns — not user commands.

Canonical `/monitor configurar` keys:

| Key | Values |
| --- | --- |
| `alertOnNewProducts` | `true` / `false` |
| `alertOnRestocks` | `true` / `false` |
| `alertOnSoldOutListings` | `true` / `false` |
| `includeKeywords` | comma-separated; `limpar` clears; max 20 nonempty entries, max 100 chars each |
| `excludeKeywords` | same rules as include |
| `checkIntervalSeconds` | integer 60–3600 (approximate; cron still once/minute) |
| `webhookUsername` | max 80 characters |

Keywords match literal substrings without case sensitivity. Any include keyword can match; exclusions win. Empty includes mean all products. All fetched products update history, even when filtered out. Filter changes apply on the next check and do not retroactively re-queue or drop alerts already queued; notification settings (mentions/template) for those pending alerts are read at delivery time.

Pause with `/monitor pausar` (or set effective enabled false). This preserves history and pending alerts. To stop the minute-by-minute invocations as well, set `triggers.crons` to `[]` in wrangler.jsonc and deploy.

Bundled defaults example (D1 overrides after first settings write):

```json
{
  "enabled": true,
  "alertOnNewProducts": true,
  "alertOnRestocks": true,
  "alertOnSoldOutListings": false,
  "includeKeywords": [],
  "excludeKeywords": [],
  "checkIntervalSeconds": 60,
  "mentionUserIds": ["207557157858574337"],
  "messageTemplate": "{mencoes}",
  "webhookUsername": "PokeBot"
}
```

Limits enforced in settings: keywords max 20 nonempty (≤100 chars each); mentions max 20; template 1–1500 chars with only `{mencoes|tipo|produto|url|estado|loja}`; rendered content ≤2000; `webhookUsername` 1–80; `checkIntervalSeconds` 60–3600.

Pushing git `main` does not by itself update the Worker. Only a deploy (manual CLI, dashboard, or a connected CI pipeline on that branch) does. If `main` auto-deploys, apply schema first so the pipeline cannot publish code that expects required tables before they exist.

## 8. Discord slash commands

After setup, manage sources and runtime settings from Discord without redeploying for those changes. There is no `/start` command — use `/monitor iniciar`.

### Create the Discord application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application (or reuse one).
2. Note the **Application ID** (digits only).
3. Under **Bot**, create a bot. You will need the **Bot Token** only for `--apply` registration below; do not put it in Worker secrets, config files, git, or chat.
4. Under **General Information**, copy the **Public Key** (used to verify interaction signatures).
5. Under **OAuth2 > URL Generator**, select scope `applications.commands`, open the generated URL, and authorize the app onto the private guild where commands should work. Note that guild's **Guild ID** (digits only; Discord: User Settings > Advanced > Developer Mode, then right-click the server > Copy Server ID).

### Ordered setup

1. **Apply the schema** (safe on existing D1). `schema.sql` uses `CREATE TABLE IF NOT EXISTS` / `INSERT OR IGNORE` for the monitor row, and adds non-destructive `source_config` and `monitor_settings` tables:

```powershell
npx.cmd wrangler d1 execute geekhaven-monitor --remote --file=./schema.sql
```

2. **Store Discord runtime keys on the Worker, then deploy** so `POST /interactions` exists. Prefer secrets (avoids wrangler.toml/jsonc vars drift). Non-secret IDs may still be stored with `secret put`. Runtime-only keys: public key, application id, guild id, webhook, admin — unchanged set:

```powershell
npx.cmd wrangler secret put DISCORD_PUBLIC_KEY
npx.cmd wrangler secret put DISCORD_APPLICATION_ID
npx.cmd wrangler secret put DISCORD_GUILD_ID
npx.cmd wrangler deploy
```

Paste the hex public key, application ID, and guild ID when prompted. Keep the existing `DISCORD_WEBHOOK_URL` (and `ADMIN_TOKEN`) secrets for drop alerts and admin routes. `DISCORD_BOT_TOKEN` is **not** needed at Worker runtime and must not be uploaded as a Worker secret.

3. **Set the Interactions Endpoint URL** in the developer portal to `https://site-monitor.YOUR-SUBDOMAIN.workers.dev/interactions` (use your real Worker URL). Discord validates the endpoint immediately with a signed PING, so the deployed Worker must already verify signatures. Signature verification follows Discord's [interaction overview](https://docs.discord.com/developers/interactions/overview).

4. **Register the three guild commands**. Dry-run (default) needs only the application and guild IDs and prints the per-command `POST` bodies without calling Discord. `--apply` also needs `DISCORD_BOT_TOKEN` in the **local** environment only. Registration **upserts `/links`, `/monitor`, and `/ajuda` individually** (not a bulk replace of unrelated guild commands) ([application commands docs](https://docs.discord.com/developers/interactions/application-commands)):

```powershell
$env:DISCORD_APPLICATION_ID = 'YOUR_APPLICATION_ID'
$env:DISCORD_GUILD_ID = 'YOUR_GUILD_ID'
npm.cmd run register:commands

$secure = Read-Host -AsSecureString 'Discord bot token'
$env:DISCORD_BOT_TOKEN = [System.Net.NetworkCredential]::new('', $secure).Password
try {
  npm.cmd run register:commands -- --apply
} finally {
  Remove-Item Env:DISCORD_BOT_TOKEN -ErrorAction SilentlyContinue
  $secure = $null
}
```

You can also run the registration script with Node 22 directly (`node scripts/register-commands.mjs`). `npm install` is not strictly required for registration alone; deps are still needed for tests and deploy. Do not paste the bot token into a command line that lands in history or source files. After this one-time deploy and registration, Discord commands change D1 sources/settings without further deploys. Rerun registration once after a code upgrade that adds or changes command definitions — not on every config/settings change.

Interaction handlers defer acknowledgment and edit the private original response so long store fetches (for example `/links testar`) stay within Discord’s timing rules. Follow-up edit budget is **8s**; `/links testar` store fetch/parse is capped at **20s**.

### Command reference

Members need **Manage Guild** (Manage Server) or **Administrator**. Commands only work for the configured application + guild. Replies are Portuguese and ephemeral (private to the caller, no mentions in the reply). Alerts use an explicit allowed user mention list (max **20** snowflakes) — never `@everyone`, `@here`, or roles.

Registered option names match `scripts/register-commands.mjs`: `url` (string), `usuario` (Discord user picker), `texto` (optional string), `opcao` (choices = canonical config keys), `valor` (string).

| Command | Notes |
| --- | --- |
| `/links adicionar url:<URL>` | Add supported HTTPS source |
| `/links listar` | List configured sources |
| `/links remover url:<URL>` | Remove source |
| `/links testar url:<URL>` | Real fetch + strict parser (≤20s); supported shapes/limits; allowed while paused; no add / no state / no notifications |
| `/monitor iniciar` | Enable monitoring |
| `/monitor pausar` | Pause (preserves history/pending) |
| `/monitor estado` | Effective enablement, pending count, compact settings, and per-source lines: baseline pendente / ok / bloqueada / erro, `produtos=`, `última=` (last scan), `erro=`, `retry=` when relevant |
| `/monitor testar` | Real labelled **TEST** to existing webhook; uses mentions/template even while paused; not restock proof; TEST label cannot be omitted |
| `/monitor marcar usuario:<USER>` | Add user (Discord user picker) to mention allowlist |
| `/monitor desmarcar usuario:<USER>` | Remove user (Discord user picker) |
| `/monitor mencoes` | Show mention allowlist |
| `/monitor mensagem texto:<TEXT>` | Set template (omit `texto` to show current). Max template length 1500; rendered content ≤ 2000 |
| `/monitor repor_mensagem` | Restore default template `{mencoes}` |
| `/monitor configurar opcao:<KEY> valor:<VALUE>` | Runtime options (table in §7); keyword `valor:limpar` clears |
| `/ajuda` | Static help |

Placeholders: `{mencoes}`, `{tipo}`, `{produto}`, `{url}`, `{estado}`, `{loja}` — no price placeholder (no price data). Default template `{mencoes}` adds tags above the existing truthful embed. Initial mention default is `['207557157858574337']`. Removing it persists and is not re-added on deploy; new bundled defaults do not override saved settings.

Example Continente search add:

```text
/links adicionar url:https://www.continente.pt/pesquisa/?q=pokemon+tcg&start=0&srule=Continente&pmin=0.01
```

Example Continente PDP add:

```text
/links adicionar url:https://www.continente.pt/produto/pokemon---cartas-tcg-mega-brave----versao-japonesa-8883406.html
```

Before the first add/remove, the Worker uses the bundled `config.json` `sources` as a fallback (two defaults upstream). `/links listar` does **not** create a `source_config` row. After the first mutation, the D1 `source_config` row is the source of truth (including an empty list, which yields `no_sources` until sources are added again). Removing a bundled default keeps it removed. Source-list changes take effect on the next check; an in-flight scan may finish with the list it already loaded. Re-adding a URL may reuse existing per-source history in `monitor` state; do not assume a fresh baseline. Supported URL shapes still apply; there is no universal arbitrary-site parser. Continente search sources are capped at 5 listing pages and 30 product-detail fetches per check. The registry allows at most 20 sources. Fresh sources keep a silent baseline; failed PDP parsing stays fail-closed; caps are unchanged.

### Diagnosing Discord PING `401`

When Discord saves the Interactions Endpoint URL it sends a signed PING. A `401` means signature verification failed. The Worker does **not** put the reason in the HTTP body (Discord only sees `Invalid request signature`). Instead it writes structured JSON to Cloudflare logs.

`DISCORD_PUBLIC_KEY` (and the application/guild IDs) are **runtime Worker secrets/vars** (Settings → Variables and Secrets, or `wrangler secret put`). They are not Build/CI variables and are not bundled from `config.json`.

**Filter logs**

```powershell
npx.cmd wrangler tail
```

In the Workers Logs UI or `wrangler tail` output, search for `discord_verification` (field `event`). Each attempt has a locally generated `diagnostic_id` (`diagnostics_version` is `1`). A successful PING emits two correlated records with the same `diagnostic_id`: verification `reason=signature_ok` then `reason=ping_ok` with `http_status=200`. Failures emit one `warn` record with `http_status=401`.

While Discord retries validation you may see both failed and successful attempts. A later `200` does not erase earlier `401`s in the log stream. **`401` does not automatically mean “wrong public key”** — use `reason` below. These log lines are not returned in the public HTTP response body and must not contain key/signature/body material.

| `reason` | Typical cause | Action |
| --- | --- | --- |
| `public_key_missing` | Secret unset/empty at runtime | `wrangler secret put DISCORD_PUBLIC_KEY`, then confirm the secret exists on this Worker |
| `public_key_type` | Runtime value is not a string | Re-set the secret as plain hex text |
| `public_key_invalid_hex` | Non-hex characters, or copy/paste quotes/whitespace | Check `key_surrounding_quotes` / `key_leading_trailing_whitespace` flags; paste raw 64-char hex only (no `"` / spaces). Do not trim in code — fix the secret |
| `public_key_invalid_length` | Hex decodes but not 32 bytes | Use the Discord application **Public Key** (64 hex chars) |
| `signature_missing` / `signature_invalid_hex` / `signature_invalid_length` | Client/proxy stripped or altered `X-Signature-Ed25519` | Confirm Discord is hitting `/interactions` directly; signature must be 128 hex chars |
| `timestamp_missing` / `timestamp_invalid_format` | Missing/bad `X-Signature-Timestamp` | Same path/proxy check |
| `timestamp_outside_window` | Clock skew or replay outside ±300s | Check Worker/system time; retries should be fresh |
| `body_read_failed` | Request body could not be read | Rare platform/request issue; retry |
| `public_key_import_failed` | WebCrypto rejected the key bytes | Confirm Ed25519 public key material; see sanitized `error_name` |
| `signature_verify_failed` | WebCrypto verify threw | See sanitized `error_name`; not the same as mismatch |
| `signature_mismatch` | Key format OK and signature length OK, but verify returned false | Wrong key for this application, body altered in transit, or signing key mismatch — format validity ≠ crypto accept |
| `signature_ok` + `ping_ok` | Verification passed; PING answered `{type:1}` | Endpoint validation should succeed |

Already deployed and only refreshing code? Prefer [UPGRADE.md](UPGRADE.md) so you keep the existing Worker and D1 `database_id` instead of creating a new database.

## Troubleshooting and limits

- `/health` confirms that the Worker responds and reports effective `enabled`; `/status` and scheduled logs confirm monitoring is working. Distinguish effective `enabled` from nested `sources.*.initialized` and from `configured`.
- HTTP 429/network errors back off, respecting Retry-After. HTTP 401/403 from the store marks that source blocked; it does not rotate IPs or bypass restrictions. After resolving the access issue, clear only that source's block/error fields in the D1 console. Replace `CANONICAL_SOURCE_URL` with the exact key from `/status` (canonical URL under `sources`): `UPDATE monitor SET state = json_set(state, '$.sources."CANONICAL_SOURCE_URL".blocked', json('false'), '$.sources."CANONICAL_SOURCE_URL".nextCheck', 0, '$.sources."CANONICAL_SOURCE_URL".failures', 0, '$.sources."CANONICAL_SOURCE_URL".lastError', json('null')) WHERE id = 1;`. Do not wipe the whole `state` or all `sources` history.
- Discord outages keep alerts queued and retry later. Rare duplicates are possible if Discord accepts a message but its response or the following database write fails. At most five queued alerts are sent per run. While the queue is pending, store checks wait for delivery to recover.
- Shopify collection pagination supports up to 2,499 products in a full scan; larger collections need a revised strategy. Conditional requests use the server ETag only when the collection fits one page. Continente search checks stop at 5 listing pages or 30 product-detail pages. The `/links` registry allows at most 20 sources.
- This runs about 1,440 scheduled invocations/day. It stores the history in one database row to keep D1 writes low. Workers Free permits only 10 ms of CPU per invocation (network wait does not count). Multi-product Continente search with multiple PDP parses may exceed Free CPU or subrequest limits; reduce search scope, use a batched architecture, or move to an explicitly approved paid plan if live metrics show `exceededCpu` or quota stops. In Cloudflare, inspect Worker Metrics/Logs for `exceededCpu` and D1 row usage after deployment. Free quotas can stop work when exceeded; there is no uptime or delivery guarantee. Costs stay bounded by existing Free warnings; this feature set does not change billing by itself.
- One-minute polling is not a guaranteed one-minute notification deadline. Store caching, rate limits, scheduling and Discord/phone delivery can add delays. A Discord notification never guarantees the product is still purchasable when you click.
- The local tests mock network responses and use SQLite (`node:sqlite`, Node 22+) for D1 operations. They verify baseline, new products/restocks, duplicates, filters, outbox retry, backoff, denial and admin authorization. They do not prove Workers Free suitability for Continente multi-PDP scans, Cloudflare-region store access, actual CPU allowance, or your friend's phone; live steps and metrics do that.

Official references: [Discord webhooks](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks), [mobile notifications](https://support.discord.com/hc/en-us/articles/218892547--Mobile-Notifications-Settings-101), [Cloudflare cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/), [D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/).
