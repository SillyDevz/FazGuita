param(
    [ValidateRange(10,3600)][int]$IntervalSeconds = 15,
    [switch]$NewOnly,
    [switch]$Once,
    [switch]$TestSound,
    [string]$MockResponsePath,
    [switch]$MockMute,
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'config.json'),
    [string]$StatePath = (Join-Path $PSScriptRoot 'pokemon-state.json')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
try { Add-Type -AssemblyName System.Windows.Extensions -ErrorAction Stop } catch { }

function Read-AlertConfig([string]$Path) {
    try {
        $Path = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
        $config = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
        $defaults = @{
            alertOnNewProducts=$true; alertOnRestocks=$true; alertOnSoldOutListings=$true
            soundRepeats=5; intervalSeconds=15; includeKeywords=@(); excludeKeywords=@(); openBrowserOnAlert=$false
        }
        foreach ($key in $defaults.Keys) {
            if ($null -eq $config.PSObject.Properties[$key]) { $config | Add-Member -NotePropertyName $key -NotePropertyValue $defaults[$key] }
        }
        foreach ($key in @('alertOnNewProducts','alertOnRestocks','alertOnSoldOutListings','openBrowserOnAlert')) {
            if ($config.$key -isnot [bool]) { throw "$key must be true or false." }
        }
        foreach ($rule in @(@('soundRepeats',1,20),@('intervalSeconds',10,3600))) {
            $value = $config.($rule[0])
            if (($value -isnot [int] -and $value -isnot [long]) -or $value -lt $rule[1] -or $value -gt $rule[2]) {
                throw "$($rule[0]) must be a whole number from $($rule[1]) to $($rule[2])."
            }
        }
        foreach ($key in @('includeKeywords','excludeKeywords')) {
            if ($config.$key -isnot [array]) { throw "$key must be an array of strings." }
            foreach ($word in $config.$key) {
                if ($word -isnot [string] -or [string]::IsNullOrWhiteSpace($word)) { throw "$key must contain nonempty strings." }
            }
        }
        if ($config.soundFile -isnot [string] -or [string]::IsNullOrWhiteSpace($config.soundFile) -or $config.soundFile.Contains('"')) {
            throw 'soundFile must be a nonempty file path without quote characters.'
        }
        if (($config.volume -isnot [int] -and $config.volume -isnot [long]) -or $config.volume -lt 0 -or $config.volume -gt 100) {
            throw 'volume must be a whole number from 0 to 100.'
        }
        $sound = $config.soundFile
        if (-not [IO.Path]::IsPathRooted($sound)) { $sound = Join-Path (Split-Path -Parent $Path) $sound }
        if (-not (Test-Path -LiteralPath $sound -PathType Leaf)) { throw "Sound file not found: $sound" }
        $config.soundFile = $sound
        return $config
    } catch { throw "Invalid alert config at ${Path}: $($_.Exception.Message)" }
}

function Update-AlertConfig([string]$Path, $Current) {
    try {
        $next = Read-AlertConfig $Path
        if (($next | ConvertTo-Json -Depth 5 -Compress) -ne ($Current | ConvertTo-Json -Depth 5 -Compress)) {
            Write-Host 'Config reloaded.' -ForegroundColor Cyan
        }
        return $next
    } catch {
        Write-Warning "$($_.Exception.Message) Keeping the last valid settings."
        return $Current
    }
}

function Select-Alerts($Changes, $Config) {
    foreach ($change in $Changes) {
        if ($change.kind -eq 'NEW PRODUCT' -and (-not $Config.alertOnNewProducts -or (-not $change.available -and -not $Config.alertOnSoldOutListings))) { continue }
        if ($change.kind -eq 'RESTOCK' -and -not $Config.alertOnRestocks) { continue }
        $included = $Config.includeKeywords.Count -eq 0
        foreach ($word in $Config.includeKeywords) {
            if ($change.title.IndexOf($word, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $included = $true; break }
        }
        if (-not $included) { continue }
        $excluded = $false
        foreach ($word in $Config.excludeKeywords) {
            if ($change.title.IndexOf($word, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $excluded = $true; break }
        }
        if (-not $excluded) { $change }
    }
}

function Play-Alert {
    $opened = $false
    try {
        $soundPath = $alertConfig.soundFile
        if ($alertConfig.volume -eq 0) { Write-Host 'Alert sound muted (volume 0).'; return }
        if (-not (Test-Path -LiteralPath $soundPath)) { throw "Missing sound: $soundPath" }
        if (-not ('PokemonMonitor.Audio' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
namespace PokemonMonitor {
    public static class Audio {
        [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
        private static extern int mciSendString(string command, StringBuilder result, int length, IntPtr window);
        [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
        private static extern bool mciGetErrorString(int error, StringBuilder text, int length);
        public static void Send(string command) {
            int error = mciSendString(command, null, 0, IntPtr.Zero);
            if (error != 0) {
                var text = new StringBuilder(256);
                mciGetErrorString(error, text, text.Capacity);
                throw new InvalidOperationException(text.ToString());
            }
        }
    }
}
'@
        }
        [PokemonMonitor.Audio]::Send('open "' + $soundPath + '" type mpegvideo alias pokemonAlert')
        $opened = $true
        [PokemonMonitor.Audio]::Send('setaudio pokemonAlert volume to ' + ($alertConfig.volume * 10))
        for ($repeat = 0; $repeat -lt $alertConfig.soundRepeats; $repeat++) {
            [PokemonMonitor.Audio]::Send('play pokemonAlert from 0 wait')
        }
        Write-Host "Alert sound played $($alertConfig.soundRepeats) times."
    } catch {
        Write-Warning "Could not play alert MP3: $($_.Exception.Message)"
    } finally {
        if ($opened) { [PokemonMonitor.Audio]::Send('close pokemonAlert') }
    }
}

function Get-Changes($Products, $Known, [bool]$IncludeRestocks) {
    foreach ($product in $Products) {
        $id = [string]$product.id
        $available = @($product.variants | Where-Object { $_.available -eq $true }).Count -gt 0
        $kind = $null
        if (-not $Known.ContainsKey($id)) { $kind = 'NEW PRODUCT' }
        elseif ($IncludeRestocks -and $available -and -not $Known[$id].available) { $kind = 'RESTOCK' }
        if ($kind) {
            [pscustomobject]@{kind=$kind; title=$product.title; available=$available; url=('https://geekhaven.pt/products/' + $product.handle)}
        }
    }
}

function Get-RetryDelay($Response, [int]$Failures) {
    $delay = [Math]::Min(900, 30 * [Math]::Pow(2, [Math]::Min($Failures - 1, 5)))
    $retry = $Response.Headers.RetryAfter
    if ($null -ne $retry) {
        if ($null -ne $retry.Delta) { $delay = [Math]::Max($delay, $retry.Delta.TotalSeconds) }
        elseif ($null -ne $retry.Date) { $delay = [Math]::Max($delay, ($retry.Date - [DateTimeOffset]::UtcNow).TotalSeconds) }
    }
    return [int][Math]::Ceiling($delay)
}

function Save-History([string]$Path, [string]$Json) {
    $Path = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    [IO.File]::WriteAllText("$Path.tmp", $Json)
    if ([IO.File]::Exists($Path)) {
        # Windows PowerShell converts $null to an empty string for this API.
        # A real backup path works on both Windows PowerShell and PowerShell 7.
        [IO.File]::Replace("$Path.tmp", $Path, "$Path.bak")
    } else {
        [IO.File]::Move("$Path.tmp", $Path)
    }
}

# Permit offline tests to import functions without starting a monitor.
if ($MyInvocation.InvocationName -eq '.') { return }
$alertConfig = Read-AlertConfig $ConfigPath
$intervalOverride = $PSBoundParameters.ContainsKey('IntervalSeconds')
if (-not $intervalOverride) { $IntervalSeconds = $alertConfig.intervalSeconds }
if ($TestSound) { Play-Alert; return }
if ($MockMute -and -not $MockResponsePath) { throw '-MockMute requires -MockResponsePath.' }
if ($MockResponsePath) {
    if (-not $PSBoundParameters.ContainsKey('StatePath')) {
        $StatePath = Join-Path $PSScriptRoot 'pokemon-mock-state.json'
    }
    $realHistory = Join-Path $PSScriptRoot 'pokemon-state.json'
    if ($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($StatePath) -eq $realHistory) {
        throw 'Mock mode cannot use the real monitor history.'
    }
    Write-Host 'MOCK MODE: local response fixture; no store requests.' -ForegroundColor Yellow
}
$StatePath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($StatePath)

$known = @{}
$initialized = Test-Path -LiteralPath $StatePath
if ($initialized) {
    try {
        $saved = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
        if ($saved.version -ne 1) { throw 'Unsupported state format.' }
        foreach ($entry in $saved.products) { $known[[string]$entry.id] = $entry }
    } catch { throw "Cannot read saved history at $StatePath. Restore it or rename it to create a fresh baseline. $_" }
}

# An exclusive lock prevents duplicate monitors from doubling traffic or corrupting history.
$lock = $null
$client = $null
try {
    try { $lock = [IO.File]::Open("$StatePath.lock", 'OpenOrCreate', 'ReadWrite', 'None') }
    catch { throw "Another monitor may be using $StatePath, or the directory is not writable." }
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AutomaticDecompression = [Net.DecompressionMethods]::GZip -bor [Net.DecompressionMethods]::Deflate
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(25)
    $client.DefaultRequestHeaders.UserAgent.ParseAdd('GeekHavenPersonalMonitor/1.0')
    $etag = $null
    $failures = 0
    Write-Host "Watching Geek Haven Pokemon every $IntervalSeconds seconds. Ctrl+C stops. Keep this terminal and PC awake."
    Write-Host "History: $StatePath"
    do {
        $alertConfig = Update-AlertConfig $ConfigPath $alertConfig
        if (-not $intervalOverride) { $IntervalSeconds = $alertConfig.intervalSeconds }
        $delay = $IntervalSeconds
        try {
            $products = @()
            $page = 1
            $nextEtag = $null
            $unchanged = $false
            do {
                $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, "https://geekhaven.pt/collections/pokemon/products.json?limit=250&page=$page")
                if ($page -eq 1 -and $etag) { $request.Headers.TryAddWithoutValidation('If-None-Match', $etag) | Out-Null }
                $response = $null
                try {
                    if ($MockResponsePath) {
                        $fixture = Get-Content -LiteralPath $MockResponsePath -Raw | ConvertFrom-Json
                        $mockStatus = [Enum]::ToObject([System.Net.HttpStatusCode], [int]$fixture.status)
                        $response = New-Object System.Net.Http.HttpResponseMessage($mockStatus)
                        $response.Content = New-Object System.Net.Http.StringContent([string]$fixture.body)
                        if ($fixture.retryAfter) { $response.Headers.TryAddWithoutValidation('Retry-After', [string]$fixture.retryAfter) | Out-Null }
                    } else {
                        $response = $client.SendAsync($request).GetAwaiter().GetResult()
                    }
                    $status = [int]$response.StatusCode
                    if ($status -eq 304) { $unchanged = $true; break }
                    if ($status -in @(401,403)) { throw "STOP: HTTP $status. Access denied; monitor will not attempt to bypass it." }
                    if (-not $response.IsSuccessStatusCode) {
                        $delay = Get-RetryDelay $response ($failures + 1)
                        throw "HTTP $status"
                    }
                    $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
                    if ($null -eq $body.products) { throw 'Invalid product feed: missing products array.' }
                    $batch = @($body.products)
                    foreach ($product in $batch) {
                        if (-not $product.id -or -not $product.handle -or $null -eq $product.variants) { throw 'Invalid product record.' }
                    }
                    $products += $batch
                    if ($page -eq 1 -and $batch.Count -lt 250 -and $response.Headers.ETag) { $nextEtag = $response.Headers.ETag.ToString() }
                } finally {
                    if ($response) { $response.Dispose() }
                    $request.Dispose()
                }
                if ($batch.Count -lt 250) { break }
                $page++
                if ($page -gt 100) { throw 'Pagination exceeded safety limit; history not changed.' }
                Start-Sleep -Seconds $IntervalSeconds
            } while ($true)

            if (-not $unchanged) {
                $changes = @()
                if ($initialized) { $changes = @(Get-Changes $products $known (-not $NewOnly)) }
                $changes = @(Select-Alerts $changes $alertConfig)
                foreach ($change in $changes) {
                    $stock = if ($change.available) { 'IN STOCK' } else { 'SOLD OUT' }
                    Write-Host "`n[$($change.kind)] $($change.title) ($stock)" -ForegroundColor Green
                    Write-Host $change.url
                    if ($alertConfig.openBrowserOnAlert) {
                        if ($MockResponsePath) { Write-Host 'MOCK: browser opening suppressed.' }
                        else {
                            try { Start-Process -FilePath $change.url }
                            catch { Write-Warning "Could not open product page: $($_.Exception.Message)" }
                        }
                    }
                }
                if ($changes.Count) {
                    if ($MockMute) { Write-Host 'MOCK: sound suppressed.' }
                    else { Play-Alert }
                }
                foreach ($product in $products) {
                    $id = [string]$product.id
                    $known[$id] = [pscustomobject]@{id=$id; available=(@($product.variants | Where-Object { $_.available -eq $true }).Count -gt 0)}
                }
                # Retain IDs of removed products so reordering/removal doesn't create false new alerts.
                $json = @{version=1; products=@($known.Values)} | ConvertTo-Json -Depth 5
                Save-History $StatePath $json
                if (-not $initialized) { Write-Host "Baseline saved: $($products.Count) products. Future additions will alert." }
                $initialized = $true
                $etag = $nextEtag
            }
            $failures = 0
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Check OK$(if ($unchanged) { ' (unchanged)' })."
        } catch {
            if ($_.Exception.Message.StartsWith('STOP:')) { throw }
            $failures++
            $delay = [Math]::Max($delay, [Math]::Min(900,30 * [Math]::Pow(2,[Math]::Min($failures - 1,5))))
            Write-Warning "Check failed: $($_.Exception.Message). Retrying in $delay seconds."
            if ($Once) { throw }
        }
        if (-not $Once) { Start-Sleep -Seconds ([int]$delay) }
    } while (-not $Once)
} finally {
    if ($client) { $client.Dispose() }
    if ($lock) { $lock.Dispose() }
}
