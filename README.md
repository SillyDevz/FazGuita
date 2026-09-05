# Geek Haven Pokemon monitor

Two versions are included:

- **Windows terminal:** run `Start-Monitor.cmd` for local monitoring and MP3 alerts.
- **Cloudflare + Discord:** follow [the cloud setup guide](cloudflare/SETUP.md) for one-minute checks with your PC switched off.

## Sound configuration

Edit `config.json` beside the monitor:

```json
{
  "soundFile": "level-up-ringtone.mp3",
  "volume": 100,
  "soundRepeats": 5,
  "intervalSeconds": 15,
  "alertOnNewProducts": true,
  "alertOnRestocks": true,
  "alertOnSoldOutListings": true,
  "includeKeywords": [],
  "excludeKeywords": [],
  "openBrowserOnAlert": false
}
```

`soundFile` selects your MP3. Relative paths are relative to the config file. For an absolute Windows path, use forward slashes, for example `C:/Users/jorge/Music/alert.mp3`. `volume` is a whole number from 0 (muted) to 100 (full player volume); Windows output volume still applies. This does not change your system volume. `soundRepeats` accepts 1-20 repetitions per batch of alerts.

Settings reload before each check, after any current sleep, backoff, or playback finishes. Invalid edits keep the last valid settings and print a warning; invalid settings at startup stop the monitor. Run `.\Start-Monitor.cmd -TestSound` to preview. To use another config, pass `-ConfigPath "C:/path/to/config.json"`.

- `intervalSeconds`: 10-3600 seconds. An explicit `-IntervalSeconds` command-line option overrides the config for that run. Server backoff still applies.
- `alertOnNewProducts` and `alertOnRestocks`: enable each event independently. `-NewOnly` always disables restock alerts for that run.
- `alertOnSoldOutListings`: include new listings that are already sold out; requires `alertOnNewProducts`.
- `includeKeywords`: empty matches all names; otherwise a name must contain at least one keyword. Example: `["Booster Box", "Elite Trainer"]`.
- `excludeKeywords`: suppress names containing any listed keyword, even when included. Example: `["JP", "Japanese"]`. Matching uses literal substrings and ignores case.
- `openBrowserOnAlert`: opens each matching product in your default browser. Disabled by default and suppressed during mock tests.

Filters control notifications only. Every fetched product still updates history. Changing filters does not retroactively alert for products already seen.

## Mock request test

Run `.\Test-MockRequests.cmd` to simulate a baseline, a new product and restock, repeated responses after restart, HTTP 304, rate limiting, denied access, malformed JSON, and NewOnly behavior. The new-product/restock response plays your MP3 five times. The test checks the real monitor parsing, detection, output, and saved history using local HTTP response fixtures. It makes no store requests and uses temporary, separate history that is cleaned up afterwards. You can keep the real monitor running.

Run `.\Test-MockRequests.cmd -MuteSound` for a silent test. A successful run ends with `PASS: all mock request scenarios`.

Double-click `Start-Monitor.cmd`, or run in Windows Terminal / PowerShell:

```powershell
cd "$HOME\Desktop\FazGuita"
.\Start-Monitor.cmd
```

No installation required. Uses Windows PowerShell and the public collection JSON feed.

- Default: one check every 15 seconds after the previous check finishes. New products (including sold-out listings) and product-level restocks play `level-up-ringtone.mp3` five times and print direct links. Keep the MP3 beside the script. Checks resume after playback finishes.
- First run saves existing products silently. History survives restarts. Leave the terminal open and the PC awake; there are no checks while stopped/asleep.
- Ctrl+C stops the monitor. To start with a new baseline, stop it and delete `pokemon-state.json`.
- A restock means a previously unavailable product now has at least one available variant. Variant changes within an already available product, price changes, and removals do not alert.
- Conditional requests use the server ETag when present. The full collection is checked; if it grows beyond 250 products, additional pages are spaced by the configured interval.
- Failures trigger exponential backoff up to 15 minutes; longer server Retry-After values are honored. Access denial stops the monitor. No proxy rotation, cache busting, or rate-limit evasion.
- 15 seconds is a chosen polling interval, not a verified store allowance or guaranteed freshness. Server caching, request duration, pagination, and throttling can delay detection. Random intervals don't grant a higher request allowance.

Options:

```powershell
.\Start-Monitor.cmd -TestSound
.\Start-Monitor.cmd -IntervalSeconds 10
.\Start-Monitor.cmd -NewOnly
.\Start-Monitor.cmd -Once
```

Minimum configurable interval is 10 seconds. `-TestSound` makes no network request. `-Once` performs a single check. The launcher uses a process-scoped execution-policy option to run this local script; it does not change your saved PowerShell policy.
