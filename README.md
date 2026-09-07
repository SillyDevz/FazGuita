# FazGuita — multi-store Pokemon stock monitor

FazGuita watches supported store URLs for new Pokemon products and restocks. Two run modes are included and stay independent:

- **Windows local:** run `Start-Monitor.cmd` for terminal checks and MP3 alerts. It uses this repo’s root `config.json` only.
- **Cloudflare + Discord:** follow the cloud guides for one-minute checks with the PC off. After deploy, Discord `/links`, `/monitor`, and `/ajuda` manage that Worker’s sources and runtime settings in D1 without touching the Windows monitor.

**Cloudflare setup paths**

- New install: [cloudflare/SETUP.md](cloudflare/SETUP.md)
- Upgrade an existing Worker: [cloudflare/UPGRADE.md](cloudflare/UPGRADE.md)
- Connect that existing Worker to GitHub Builds: [cloudflare/UPGRADE.md — Connect the existing Worker to GitHub](cloudflare/UPGRADE.md#connect-the-existing-worker-to-github)
- Discord application + slash commands (after Worker basics): [cloudflare/SETUP.md §8](cloudflare/SETUP.md#8-discord-slash-commands)

Pushing `main` updates the git repo. It does **not** update a deployed Worker unless you also connect Cloudflare Builds (or another CI) to that branch. How: [UPGRADE.md § Connect the existing Worker to GitHub](cloudflare/UPGRADE.md#connect-the-existing-worker-to-github). If `main` is wired to auto-deploy, apply D1 schema **before** that deploy can race ahead of tables the new code expects; schema-first is advised. The `monitor_settings` table is also auto-created non-destructively on first settings use, so this settings feature does not need a separate manual migration on an existing schema that already has `monitor` / `source_config`.

## Source links

Add URLs to `sources` in the relevant `config.json` (root for Windows; `cloudflare/config.json` bundled defaults for the Worker before any `/links` mutation).

```json
"sources": [
  "https://geekhaven.pt/collections/pokemon",
  "https://www.continente.pt/pesquisa/?q=pokemon+tcg&start=0&srule=Continente&pmin=0.01",
  "https://www.continente.pt/produto/pokemon---cartas-tcg-mega-brave----versao-japonesa-8883406.html"
]
```

Supported HTTPS shapes only (not arbitrary websites or category pages):

- Shopify collections: `/collections/name` (optionally ending in `/products.json`)
- Shopify individual products: `/products/handle` (optional `.json`)
- Continente product pages: `/produto/*.html`
- Continente search: `/pesquisa/` with a nonempty `q`

Tracking parameters and fragments are dropped. Continente search keeps sorted allowlisted filters (`q`, `srule`, `pmin`, `pmax`, `start`, `sz`), rejects duplicate allowed keys, and canonicalizes to `www` HTTPS. Duplicate configured source URLs are rejected by `sourcesFor` / the PowerShell config loader. Discord `/links adicionar` does not re-add an already-present canonical URL. Within a Continente search check, product links discovered on listing pages are deduped by product id.

Each newly added source starts with a **silent baseline** (no drop alerts for products already present). Re-adding a URL may reuse existing per-source history; do not assume a wiped baseline. Old Geek Haven history migrates into the per-source map automatically. History, conditional requests, and backoff are independent per source.

Sold-out new listings are suppressed by default. Existing configurations that set `alertOnSoldOutListings` to `true` keep that behavior. Missing or unrecognized availability leaves previous history intact (fail-closed), so a parse failure does not invent a restock. Continente product pages use the matching product’s structured availability; an explicit sold-out primary product wrapper or PDP button (including a disabled add-to-cart control) overrides an in-stock structured value. Continente search discovers product tiles, then confirms stock on each product page rather than trusting listing markup. That reduces false positives but still cannot guarantee stock at a later click, for your account, selected variant, store location, or checkout. Search checks fail closed on unknown markup and stop the source update when more than **5 listing pages** or **30 product-detail pages** would be required. The Discord `/links` registry allows at most **20** sources.

Public stock is not a guarantee of purchase success; it can change before you open the link.

## Windows local monitor

Edit root `config.json` beside the monitor:

```json
{
  "sources": [
    "https://geekhaven.pt/collections/pokemon",
    "https://www.continente.pt/pesquisa/?q=pokemon+tcg&start=0&srule=Continente&pmin=0.01"
  ],
  "soundFile": "level-up-ringtone.mp3",
  "volume": 100,
  "soundRepeats": 5,
  "intervalSeconds": 15,
  "alertOnNewProducts": true,
  "alertOnRestocks": true,
  "alertOnSoldOutListings": false,
  "includeKeywords": [],
  "excludeKeywords": [],
  "openBrowserOnAlert": false
}
```

`soundFile` selects your MP3. Relative paths are relative to the config file. For an absolute Windows path, use forward slashes, for example `C:/Users/you/Music/alert.mp3`. `volume` is a whole number from 0 (muted) to 100 (full player volume); Windows output volume still applies. This does not change your system volume. `soundRepeats` accepts 1–20 repetitions per batch of alerts.

Settings reload before each check, after any current sleep, backoff, or playback finishes. Invalid edits keep the last valid settings and print a warning; invalid settings at startup stop the monitor. Run `.\Start-Monitor.cmd -TestSound` to preview. To use another config, pass `-ConfigPath "C:/path/to/config.json"`.

- `intervalSeconds`: 10–3600 seconds. An explicit `-IntervalSeconds` command-line option overrides the config for that run. Server backoff still applies.
- `alertOnNewProducts` and `alertOnRestocks`: enable each event independently. `-NewOnly` always disables restock alerts for that run.
- `alertOnSoldOutListings`: include new listings that are already sold out; requires `alertOnNewProducts`.
- `includeKeywords`: empty matches all names; otherwise a name must contain at least one keyword. Example: `["Booster Box", "Elite Trainer"]`.
- `excludeKeywords`: suppress names containing any listed keyword, even when included. Example: `["JP", "Japanese"]`. Matching uses literal substrings and ignores case.
- `openBrowserOnAlert`: opens each matching product in your default browser. Disabled by default and suppressed during mock tests.

Filters control notifications only. Every fetched product still updates history. Changing filters does not retroactively alert for products already seen.

### Mock request test

Run `.\Test-MockRequests.cmd` to simulate a baseline, a new product and restock, repeated responses after restart, HTTP 304, rate limiting, denied access, malformed JSON, and NewOnly behavior. The new-product/restock response plays your MP3 five times. The test checks the real monitor parsing, detection, output, and saved history using local HTTP response fixtures. It makes no store requests and uses temporary, separate history that is cleaned up afterwards. You can keep the real monitor running.

Run `.\Test-MockRequests.cmd -MuteSound` for a silent test. A successful run ends with `PASS: all mock request scenarios`.

### Run locally

Double-click `Start-Monitor.cmd`, or from Windows Terminal / PowerShell in your clone:

```powershell
cd PATH\to\FazGuita
.\Start-Monitor.cmd
```

No Node install is required for the Windows monitor. It targets Windows PowerShell (including 5.1-compatible patterns used in the scripts) and public Shopify feeds or Continente product/search pages.

- Default: one check every 15 seconds after the previous check finishes. Available new products and product-level restocks play `level-up-ringtone.mp3` five times and print direct links. Keep the MP3 beside the script. Checks resume after playback finishes.
- First run saves existing products silently. History survives restarts. Leave the terminal open and the PC awake; there are no checks while stopped/asleep.
- Ctrl+C stops the monitor. To start with a new baseline, stop it and delete `pokemon-state.json`.
- A restock means a previously unavailable product now has at least one available variant. Variant changes within an already available product, price changes, and removals do not alert.
- Conditional requests use the server ETag when present for Shopify sources. Continente search always rechecks product pages and does not skip them from a listing ETag. The full Shopify collection is checked; if it grows beyond 250 products, additional pages are spaced by the configured interval.
- Failures trigger exponential backoff up to 15 minutes; longer server Retry-After values are honored. Failures are isolated per source; access denial stops a single-source monitor, while multiple sources continue with backoff. No proxy rotation, cache busting, or rate-limit evasion.
- 15 seconds is a chosen polling interval between completed checks, not a verified store allowance or guaranteed freshness. Continente search confirms each product page with about one second between PDP requests (not the full scan interval), so a multi-product search still takes longer than a single Shopify check and can delay later sources in the same cycle; stock can change during that window. Server caching, request duration, pagination, and throttling can further delay detection. Random intervals don't grant a higher request allowance.

Options:

```powershell
.\Start-Monitor.cmd -TestSound
.\Start-Monitor.cmd -IntervalSeconds 10
.\Start-Monitor.cmd -NewOnly
.\Start-Monitor.cmd -Once
```

Minimum configurable interval is 10 seconds. `-TestSound` makes no network request. `-Once` performs a single check. The launcher uses a process-scoped execution-policy option to run this local script; it does not change your saved PowerShell policy.

## Cloudflare + Discord (summary)

The Worker checks about once per minute (cron still `* * * * *`; `checkIntervalSeconds` is an approximate spacing hint and backoff can delay further), stores history and pending alerts in D1, and posts matching products to Discord.

Runtime settings (enablement, alert toggles, keywords, interval, webhook username, mention list, message template) live in a D1 singleton `monitor_settings` alongside unchanged `source_config` and `monitor`. D1 values override bundled `cloudflare/config.json` defaults and survive redeploy. Sources keep existing D1 `source_config` semantics. The `monitor_settings` table is in `schema.sql` and is also auto-created non-destructively on first settings use; no separate manual migration is required for this settings feature on an existing schema. Fresh installs still apply the full schema.

Bundled `cloudflare/config.json` ships `"enabled": true` for this authorized deployment (root Windows `config.json` is untouched). New installs should explicitly set `"enabled": false` before the first deploy until secrets and schema are ready, then start with `/monitor iniciar`. Source URLs, filters, mentions, template, and other runtime settings apply via Discord without redeploy. Infrastructure secrets, cron, and hard caps are not user commands.

Admin diagnostics: `/health` reports effective `enabled` (D1 override when present); `/status` uses dynamic settings and nested per-source history under `sources`, plus `configured`; `/check`, `/test`. Check results can report `paused`, `waiting`, `no_sources`, `ok`, `blocked`, or `error`. Pending alerts and history are preserved across pauses. Settings take effect on the next operation/check; an already-running scan or send may finish with the settings it loaded (no mid-fetch cancel or live swap). Pending alerts use current notification settings (mentions/template) for their delivery run, not a snapshot stored at detection. Filters that already queued an alert are not re-evaluated retroactively.

Slash commands (Manage Guild or Administrator; correct application + guild only; ephemeral private replies with no mentions):

| Command | Purpose |
| --- | --- |
| `/links adicionar` `/links listar` `/links remover` | Manage source URLs in D1 |
| `/links testar url:SOURCE` | Real fetch + strict parser (≤20s); allowed while paused; no add / no state / no notifications |
| `/monitor iniciar` `/monitor pausar` `/monitor estado` | Start, pause, status (per-source baseline/products/last scan/errors; no `/start`) |
| `/monitor testar` | Real labelled **TEST** to the existing webhook (uses mentions/template even while paused; not restock proof) |
| `/monitor marcar` `/monitor desmarcar` `/monitor mencoes` | Explicit user mention allowlist (max 20; no everyone/here/roles) |
| `/monitor mensagem` `/monitor repor_mensagem` | Custom template / restore default |
| `/monitor configurar` | Runtime options (see SETUP) |
| `/ajuda` | Static help |

Default mention list is `['207557157858574337']`. Removing it persists and is not re-added on deploy; new bundled defaults do not override saved settings. Template placeholders: `{mencoes}`, `{tipo}`, `{produto}`, `{url}`, `{estado}`, `{loja}` (no price). Default template `{mencoes}` adds tags above the existing truthful embed. **TEST** always keeps an explicit label.

After a code upgrade that adds `/monitor` and `/ajuda`, rerun the registration script once (`--apply` upserts the three guild commands individually). Bot token stays local for registration only.

Cloudflare Worker tests need **Node.js 22+** (`node:sqlite` / `DatabaseSync`). See [SETUP.md](cloudflare/SETUP.md) for a clean install and [UPGRADE.md](cloudflare/UPGRADE.md) to refresh an existing Worker without creating a new database.
