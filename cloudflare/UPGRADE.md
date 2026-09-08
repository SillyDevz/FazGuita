# Upgrade an existing Cloudflare Worker

Use this when FazGuita’s Worker is **already deployed** and you want the multi-store / Discord `/links` `/monitor` `/ajuda` / D1 settings code without creating a new Worker or D1 database. For a first-time install, use [SETUP.md](SETUP.md) instead.

PowerShell examples below. On macOS/Linux/bash, replace `npm.cmd` / `npx.cmd` with `npm` / `npx` and use equivalent shell syntax.

## 1. Inventory what you already have

Before pulling code, write down (offline notes, not the git repo):

- Worker **name** (default upstream: `site-monitor`)
- D1 **database name**, **database_id** UUID, and binding name (**`DB`**)
- Worker URL (`https://….workers.dev`)
- Which secrets already exist (`DISCORD_WEBHOOK_URL`, `ADMIN_TOKEN`, and later Discord keys)

Cloudflare dashboard path: **Workers & Pages** → your existing Worker → **Settings** → **Bindings** (D1: binding `DB`) and **Variables and Secrets**.

Do **not** create a new Worker or a new D1 database. Do **not** reset monitor state.

## 2. Preserve local deployment config

Keep your real `database_id` (and any account-specific wrangler values) in the local `wrangler.jsonc` you deploy with. Do not commit real account IDs or tokens to a shared remote if your workflow treats them as private. The repo’s committed `wrangler.jsonc` already contains **deployment-specific** Worker/`database_id` values for an existing install — they are not a blank placeholder. On upgrade, **preserve your existing** `DB` binding and `database_id` UUID; do not replace them with another account’s committed ID and do not create a new D1 database.

Recommended: copy today’s working `wrangler.jsonc` aside, then after `git pull` restore **name**, **database_id**, **DB** binding, and `triggers.crons` (keep `* * * * *` unless you intentionally paused cron).

## 3. Update the git checkout (clean tree only)

```powershell
cd PATH\to\YOUR\FazGuita
git switch main
git pull --ff-only
```

Use `--ff-only` on a clean checkout. Do **not** discard unrelated local modifications to make the pull succeed; commit, stash, or finish that work first.

```powershell
cd .\cloudflare
npm.cmd install
npm.cmd test
npx.cmd wrangler login
```

Tests need **Node.js 22+** (`node:sqlite`). Run `wrangler login` even if you already use the Cloudflare dashboard; CLI deploy/export/schema need an authenticated Wrangler session.

## 4. Point wrangler at the existing Worker + D1

Align committed/`wrangler.jsonc` fields with your inventory from step 1 (preserve your existing D1 UUID and `DB` binding):

- `"name": "site-monitor"` (or your existing Worker name — must match the Worker you will deploy onto)
- `d1_databases[0].binding`: `"DB"`
- `d1_databases[0].database_name`: your existing D1 name
- `d1_databases[0].database_id`: your existing UUID
- `triggers.crons`: keep `["* * * * *"]` for per-minute checks

Do not add a second D1 binding.

## 5. Backup D1, then apply schema (schema-first)

Export a remote backup **outside** the git checkout (keep it private; do not commit):

```powershell
$backupPath = Join-Path $HOME ('FazGuita-D1-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.sql')
npx.cmd wrangler d1 export geekhaven-monitor --remote --output=$backupPath
```

Use your real database **name** if it differs. If CLI export is unavailable in your environment, use the Cloudflare dashboard D1 [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) / recovery guidance for that database instead — do not invent alternate export commands.

Apply the rerunnable schema. This creates `source_config` and `monitor_settings` **tables** if missing and leaves `monitor` (and any existing config **rows**) intact (`CREATE TABLE IF NOT EXISTS`, `INSERT OR IGNORE` for the monitor singleton):

```powershell
npx.cmd wrangler d1 execute geekhaven-monitor --remote --file=.\schema.sql
```

**No separate manual migration is required for the settings feature** on an existing schema that already has `monitor` / `source_config`: `monitor_settings` is also auto-created non-destructively on first settings use. Fresh setups still apply the full schema. Prefer applying `schema.sql` once before deploy so tables exist ahead of code that expects them.

**Migration order: schema first, then deploy.** If `main` is connected to an auto-deploy pipeline, applying schema before that pipeline publishes code avoids a window where new routes expect tables that are missing. A git push alone is not a Worker deploy unless that connection exists.

## 6. Source list and runtime settings after upgrade

- The `source_config` **table** must exist (step 5). Fallback applies only when the singleton **row** is absent: `getSources` then returns the **two** bundled `config.json` sources.
- `/links listar` does **not** insert a config row.
- After the **first** add/remove mutation, D1 `source_config` is authoritative — including an empty list (`no_sources` until you add URLs again).
- First genuinely new sources baseline silently; existing per-source history is reused when a URL is re-added. Failed PDP parsing stays fail-closed; caps unchanged.
- Runtime settings (enablement, alert toggles, keywords, interval, webhook username, mentions, template) persist in D1 singleton `monitor_settings`. D1 values override bundled defaults and survive redeploy. Sources keep existing `source_config` semantics.
- Settings take effect on the **next** operation/check. An already-running scan or send may finish with the settings it loaded — there is no instantaneous cancel or mid-fetch config swap. Pending alerts use **current notification settings** (mentions/template) for their delivery run, not a snapshot stored at detection. Filters that already queued an alert are not re-evaluated retroactively.
- Default mention list is `['207557157858574337']`. Removing it persists and is not re-added on deploy; new bundled defaults do not override saved settings.

## 7. Config flags and Discord runtime keys only

Bundled `cloudflare/config.json` ships `"enabled": true` for this authorized deployment (root Windows config untouched). After upgrade, prefer `/monitor iniciar` / `/monitor pausar` for effective enablement so the choice is stored in D1 and survives later redeploys of the bundled file. A blind deploy of code alone does not wipe saved D1 settings.

Preserve existing `DISCORD_WEBHOOK_URL` and `ADMIN_TOKEN`. Do not rotate them unless compromised. Runtime-only Worker keys remain: public key, application id, guild id, webhook, admin — unchanged. Bot token stays local for registration only (never Worker/git/chat).

### Discord app values (needed before `secret put`)

Create or reuse a Discord application ([Developer Portal](https://discord.com/developers/applications); fuller UI walkthrough in [SETUP.md §8](SETUP.md#8-discord-slash-commands)):

1. **Application ID** — General Information (digits only) → becomes `DISCORD_APPLICATION_ID`
2. **Public Key** — General Information (hex) → becomes `DISCORD_PUBLIC_KEY`
3. **Bot** — create the bot if needed; copy the **Bot Token** only for local registration in step 9 (never a Worker secret)
4. **Guild install** — OAuth2 → URL Generator → scope `applications.commands` → open the URL and authorize onto your private server
5. **Guild ID** — enable Developer Mode, right-click that server → Copy Server ID (digits only) → becomes `DISCORD_GUILD_ID`

Store the three Worker runtime keys (secrets are fine for non-secret IDs; avoids a wrangler vars sync trap). Do **not** deploy or register commands in this step:

```powershell
npx.cmd wrangler secret put DISCORD_PUBLIC_KEY
npx.cmd wrangler secret put DISCORD_APPLICATION_ID
npx.cmd wrangler secret put DISCORD_GUILD_ID
```

## 8. Deploy onto the same Worker

CLI (recommended — uploads the multi-file Worker, imported JSON, and modules; do not paste only `worker.js` into the dashboard editor):

```powershell
npx.cmd wrangler deploy
```

That updates the **existing** Worker named in `wrangler.jsonc`, keeps the same `workers.dev` route when unchanged, and retains the cron trigger from config. `POST /interactions` must exist on this deploy before Discord can validate the endpoint in step 9. `/ajuda` always replies immediately (private); other fast commands normally return a complete private reply directly (bounded ~1.3s, defer only if slow); `/links testar` and `/monitor testar` still ack then edit the private original (21s work budget, ≤28s overall completion attempt; PATCH 8s capped by remaining overall; `/links testar` parser still 20s). The timeout edit is best-effort — Discord outage or platform interruption can leave the deferred ack without a final reply.

Dashboard users: **Workers & Pages** → existing Worker → create/upload a **version** that includes the full build (CLI `wrangler deploy` is the supported path). Under **Settings → Bindings**, confirm D1 binding **`DB`**. Under **Variables and Secrets**, confirm webhook, admin, and Discord keys. Do not replace the Worker with a newly created empty one.

This version also replaces unsupported `redirect: 'error'` with `redirect: 'manual'` on store, webhook and interaction PATCH requests. Redirects are still rejected, not followed; Shopify `304 Not Modified` caching remains supported. The old mode can prevent both TEST delivery and completion of the private “thinking…” response in workerd.

## 9. Interactions Endpoint, then command registration

1. In the Discord developer portal, set **Interactions Endpoint URL** to `https://YOUR-WORKER.workers.dev/interactions` (your real Worker URL). Discord validates immediately with a signed PING; the Worker from step 8 must already verify signatures.

2. Register the three guild commands. Dry-run needs only application and guild IDs (no bot token). `--apply` needs the bot token in the **local** environment only. The script **POSTs upserts for `/links`, `/monitor`, and `/ajuda` individually** — it does not bulk-replace unrelated guild commands:

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

You can run the script with Node 22 directly (`node scripts/register-commands.mjs`). `npm install` is not strictly required for registration alone; deps remain needed for tests/deploy. Do not paste the bot token into command history or source files. Never upload `DISCORD_BOT_TOKEN` as a Worker secret.

**Existing installs must rerun registration once** after this code upgrade (new `/monitor` and `/ajuda`, expanded `/links`). Do not rerun on every settings/config change.

## 10. Verify

Prompt for the **existing** `ADMIN_TOKEN` (do not rotate). Build headers, then call health/status:

```powershell
$workerUrl = 'https://site-monitor.YOUR-SUBDOMAIN.workers.dev'
$secureAdmin = Read-Host -AsSecureString 'Existing ADMIN_TOKEN'
try {
  $adminToken = [System.Net.NetworkCredential]::new('', $secureAdmin).Password
  $headers = @{ Authorization = "Bearer $adminToken" }
  Invoke-RestMethod -Uri "$workerUrl/health"
  Invoke-RestMethod -Uri "$workerUrl/status" -Headers $headers
} finally {
  Remove-Item Variable:adminToken -ErrorAction SilentlyContinue
  $secureAdmin = $null
}
```

Confirm:

- `/health` responds; `enabled` is the **effective** value (D1 override when present)
- `/status` shows nested `sources` history, `configured` list, dynamic settings, and preserved `pending` when applicable
- Discord (Manage Guild / Administrator; ephemeral private replies): `/links listar`, `/links testar url:…`, `/links adicionar`, `/links remover`, `/monitor testar`, `/monitor iniciar`, `/monitor estado`, `/ajuda`. Example: `/links adicionar url:https://www.continente.pt/pesquisa/?q=pokemon+tcg&start=0&srule=Continente&pmin=0.01`
- Suggested sequence: list/test a supported source → `/monitor testar` receives a real labelled **TEST** with tags → `/monitor iniciar` → `/monitor estado` shows per-source baseline / product count / last scan / errors. Deferred follow-up: 21s work / ≤28s overall completion attempt; PATCH 8s capped by remaining overall; `/links testar` source/parser budget still 20s. Timeout edit is best-effort (Discord outage or platform interruption can leave no final reply). These do not prove checkout stock or phone delivery.
- Optional admin webhook check — **sends a real TEST message** to Discord (reuse the same secure prompt pattern for `$headers` if the previous `try` block ended):

```powershell
$secureAdmin = Read-Host -AsSecureString 'Existing ADMIN_TOKEN'
try {
  $adminToken = [System.Net.NetworkCredential]::new('', $secureAdmin).Password
  $headers = @{ Authorization = "Bearer $adminToken" }
  Invoke-RestMethod -Method Post -Uri "$workerUrl/test" -Headers $headers
} finally {
  Remove-Item Variable:adminToken -ErrorAction SilentlyContinue
  $secureAdmin = $null
}
```

Notifications never guarantee stock still exists when you click. Full command table, template placeholders, and config keys: [SETUP.md §7–8](SETUP.md#7-change-filters-mentions-template-or-pause).

## Connect the existing Worker to GitHub

Optional. Use this when you want pushes to update the **same** already-deployed Worker. Official docs: [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/), [build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).

1. **Schema first (manual).** Apply `schema.sql` to the existing D1 database (step 5) **before** the first automated production deploy. Auto-deploy does not run schema for you. (`monitor_settings` can also auto-create on first use, but prefer schema-first.)
2. **Committed `wrangler.jsonc` must match production.** GitHub Builds uses the **committed** file in the repo root directory — not a local-only edit and not dashboard-only bindings. Before enabling Builds, ensure the committed config’s Worker `name` matches the existing Worker and that `database_id` is **your** real existing D1 UUID (preserve the binding you already run; do not swap in another account’s committed ID). The D1 UUID is an identifier, not an auth secret; commit it only if your privacy policy allows. Do not invent unimplemented “generate config from build vars” support here. Secrets never go in git.
3. **`enabled` and D1 settings.** Bundled `cloudflare/config.json` ships `"enabled": true` for this authorized deployment. Saved D1 `monitor_settings` override bundled defaults after the first settings write and survive CI redeploys. New installs should still set `false` before first deploy until secrets/schema are ready (see SETUP). Prefer Discord `/monitor` for day-to-day pause/start so the choice persists in D1.
4. **Connect Builds to the existing Worker** ([connect an existing Worker](https://developers.cloudflare.com/workers/ci-cd/builds/#connect-an-existing-worker)): Cloudflare dashboard → **Workers & Pages** → **your existing Worker** (not Create Pages / not a new Worker) → **Settings** → **Builds** → **Connect**. Authorize GitHub for **only** the `SillyDevz/FazGuita` repository.
5. **Build settings** ([configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)):
   - Production branch: `main`
   - Root directory: `cloudflare`
   - Build command: `npm test` (may be blank; tests recommended)
   - Deploy command: `npx wrangler deploy` (default; uses the Wrangler package already listed under `devDependencies`)
   - Build variable: `NODE_VERSION` = `22` (official build-image support; npm deps install automatically from `package.json`)
6. **Runtime secrets stay in the dashboard.** Under the same Worker → **Settings** → **Variables and Secrets**, keep these five runtime keys: `DISCORD_WEBHOOK_URL`, `ADMIN_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID`. Never put `DISCORD_BOT_TOKEN` on the Worker (registration-only, local). Build variables are not Worker runtime secrets.

Enabling Builds is a deliberate dashboard action. This guide does not run CI or deploy for you. After connect, a push to `main` can deploy before you finish schema — finish steps 1–2 first. Rerun command registration once after the upgrade deploy if `/monitor` / `/ajuda` are not yet registered.

## Reminders

- Commit/push updates git; they are not a manual deploy unless Builds (above) is connected.
- Connected `main` auto-pipelines can deploy before you finish schema — apply schema first.
- Sources, filters, tags, message, and settings apply without redeploy; secrets/cron/caps do not.
- Free CPU/subrequest limits still apply; reduce Continente scope or use an explicitly approved paid plan if metrics demand it. This upgrade does not change billing by itself.
