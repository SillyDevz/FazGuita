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
            alertOnNewProducts=$true; alertOnRestocks=$true; alertOnSoldOutListings=$false
            sources=@('https://geekhaven.pt/collections/pokemon'); soundRepeats=5; intervalSeconds=15; includeKeywords=@(); excludeKeywords=@(); openBrowserOnAlert=$false
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
        if ($config.sources -isnot [array] -or $config.sources.Count -eq 0) { throw 'sources must be a nonempty array of URLs.' }
        $config.sources = @($config.sources | ForEach-Object { (Get-Source $_).url } | Select-Object -Unique)
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

function Get-Source($Url) {
    if ($Url -isnot [string]) { throw 'Source must be an HTTPS URL.' }
    $uri = $null
    if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'https' -or $uri.UserInfo) { throw 'Source must be an HTTPS URL without credentials.' }
    $path = $uri.AbsolutePath.TrimEnd('/')
    $origin = $uri.GetLeftPart([UriPartial]::Authority)
    if ($uri.Host -in @('continente.pt','www.continente.pt')) {
        if ($path -match '^/produto/[^/]+-(\d+)\.html$') {
            return [pscustomobject]@{url="$origin$path"; endpoint="$origin$path"; origin=$origin; kind='continente'; sku=$Matches[1]}
        }
        if ($path -eq '/pesquisa') {
            $allowed = @('q','srule','pmin','pmax','start','sz')
            $selected = @{}
            $raw = $uri.Query.TrimStart('?')
            if ($raw) {
                foreach ($part in $raw.Split('&')) {
                    if ($part.Length -eq 0) { continue }
                    $eq = $part.IndexOf('=')
                    if ($eq -lt 0) { $name = $part; $value = '' } else { $name = $part.Substring(0, $eq); $value = $part.Substring($eq + 1) }
                    $key = [Uri]::UnescapeDataString($name.Replace('+',' '))
                    if ($key -notin $allowed) { continue }
                    if ($selected.ContainsKey($key)) { throw 'Continente search rejects duplicate filters.' }
                    $selected[$key] = $value
                }
            }
            if (-not $selected.ContainsKey('q')) { throw 'Continente search requires a nonempty q parameter.' }
            $q = [Uri]::UnescapeDataString([string]$selected['q'].Replace('+',' ')).Trim()
            if ([string]::IsNullOrWhiteSpace($q)) { throw 'Continente search requires a nonempty q parameter.' }
            $selected['q'] = [Uri]::EscapeDataString($q)
            if ($selected.ContainsKey('start')) {
                $startValue = [Uri]::UnescapeDataString([string]$selected['start'].Replace('+',' '))
                if ($startValue -notmatch '^(0|[1-9]\d*)$') { throw 'Continente search start must be a nonnegative integer.' }
                $selected['start'] = $startValue
            }
            if ($selected.ContainsKey('sz')) {
                $szValue = [Uri]::UnescapeDataString([string]$selected['sz'].Replace('+',' '))
                if ($szValue -notmatch '^[1-9]\d*$') { throw 'Continente search sz must be a positive integer.' }
                $selected['sz'] = $szValue
            }
            $query = (($selected.Keys | Sort-Object) | ForEach-Object { "$_=$($selected[$_])" }) -join '&'
            $canonical = "https://www.continente.pt/pesquisa/?$query"
            return [pscustomobject]@{url=$canonical; endpoint=$canonical; origin='https://www.continente.pt'; kind='continente-search'}
        }
        throw 'Continente requires a /produto/*.html or /pesquisa/?q=... link.'
    }
    if ($path -match '^/collections/[^/]+(?:/products\.json)?$' -or $path -eq '/products.json') {
        if ($path -ne '/products.json') { $path = $path -replace '/products\.json$', '' }
        $endpoint = if ($path -eq '/products.json') { "$origin$path" } else { "$origin$path/products.json" }
        return [pscustomobject]@{url="$origin$path"; endpoint=$endpoint; origin=$origin; kind='collection'}
    }
    if ($path -match '^/products/[^/.]+(?:\.json)?$') {
        $path = $path -replace '\.json$', ''
        return [pscustomobject]@{url="$origin$path"; endpoint="$origin$path.json"; origin=$origin; kind='product'}
    }
    throw 'Unsupported source path. Use a Shopify collection/product or Continente product/search URL.'
}

function Get-Availability($Product) {
    if (-not $Product.id -or -not $Product.handle -or $Product.variants -isnot [array] -or $Product.variants.Count -eq 0) { throw 'Invalid product record.' }
    foreach ($variant in $Product.variants) {
        if ($variant.available -isnot [bool]) { throw 'Invalid product availability: expected a boolean.' }
    }
    return @($Product.variants | Where-Object { $_.available -eq $true }).Count -gt 0
}

function Get-JsonLdProducts($Node) {
    if ($null -eq $Node) { return }
    if ($Node -is [array]) { foreach ($item in $Node) { Get-JsonLdProducts $item }; return }
    if (@($Node.'@type') -contains 'Product') { $Node }
    if ($Node.'@graph') { Get-JsonLdProducts $Node.'@graph' }
}

function Convert-SourceBody([string]$Body, $Source) {
    if ($Source.kind -ne 'continente') {
        try { $data = $Body | ConvertFrom-Json } catch { throw 'Invalid product JSON.' }
        if ($Source.kind -eq 'product') {
            if ($null -eq $data.product) { throw 'Invalid product response.' }
            $products = @($data.product)
        } else {
            if ($data.products -isnot [array]) { throw 'Invalid product feed: missing products array.' }
            $products = @($data.products)
        }
        foreach ($product in $products) { $null = Get-Availability $product }
        return $products
    }
    $matchesProduct = @()
    foreach ($script in [regex]::Matches($Body, '(?is)<script\b[^>]*\btype\s*=\s*["'']application/ld\+json["''][^>]*>(.*?)</script>')) {
        $nodes = Get-JsonLdProducts ($script.Groups[1].Value | ConvertFrom-Json)
        $matchesProduct += @($nodes | Where-Object { [string]$_.sku -eq $Source.sku })
    }
    if ($matchesProduct.Count -ne 1) { throw 'Invalid Continente product: missing or ambiguous matching SKU.' }
    $product = $matchesProduct[0]
    $offers = @($product.offers)
    if ($offers.Count -eq 0) { throw 'Missing Continente offers.' }
    $statuses = @()
    foreach ($offer in $offers) {
        switch -Regex ($offer.availability) {
            '^https?://schema\.org/InStock$' { $statuses += $true; break }
            '^https?://schema\.org/(OutOfStock|SoldOut|Discontinued)$' { $statuses += $false; break }
            default { throw 'Unknown Continente availability.' }
        }
    }
    if (@($statuses | Select-Object -Unique).Count -ne 1) { throw 'Conflicting Continente offers.' }
    $available = $statuses[0]
    foreach ($button in [regex]::Matches($Body, '(?is)<button\b([^>]*)>')) {
        $attrText = $button.Groups[1].Value
        $attrs = @{}
        foreach ($attr in [regex]::Matches($attrText, '([\w-]+)\s*=\s*["'']([^"'']*)["'']')) { $attrs[$attr.Groups[1].Value] = $attr.Groups[2].Value }
        if ($attrs['data-container'] -ne 'pdp' -or $attrs['data-pid'] -ne $Source.sku) { continue }
        if ($attrs.ContainsKey('data-outofstock')) {
            if ($attrs['data-outofstock'] -ceq 'true') { $available = $false }
            elseif ($attrs['data-outofstock'] -cne 'false') { throw 'Unknown Continente PDP availability.' }
        }
        if ($attrText -match '(?i)(?:^|\s)disabled(?:\s|=|$)') { $available = $false }
    }
    foreach ($div in [regex]::Matches($Body, '(?is)<div\b([^>]*)>')) {
        $attrs = @{}
        foreach ($attr in [regex]::Matches($div.Groups[1].Value, '([\w-]+)\s*=\s*["'']([^"'']*)["'']')) { $attrs[$attr.Groups[1].Value] = $attr.Groups[2].Value }
        $className = [string]$attrs['class']
        if ($className -notmatch '(?i)(^|\s)product-detail(\s|$)' -or $className -notmatch '(?i)(^|\s)product-wrapper(\s|$)') { continue }
        if ($attrs['data-pid'] -ne $Source.sku) { continue }
        if ($attrs.ContainsKey('data-is-product-out-of-stock')) {
            if ($attrs['data-is-product-out-of-stock'] -ceq 'true') { $available = $false }
            elseif ($attrs['data-is-product-out-of-stock'] -cne 'false') { throw 'Unknown Continente PDP availability.' }
        }
        if ($className -match '(?i)(^|\s)product-out-of-stock(\s|$)') { $available = $false }
    }
    if ([string]::IsNullOrWhiteSpace($product.name)) { throw 'Missing Continente product name.' }
    [pscustomobject]@{id=$Source.sku; title=$product.name; handle=$Source.sku; url=$Source.url; variants=@([pscustomobject]@{available=[bool]$available})}
}

function Get-ContinenteSearchFooter([string]$Body) {
    $footers = @([regex]::Matches($Body, '(?is)<div\b([^>]*\bgrid-footer\b[^>]*)>'))
    if ($footers.Count -ne 1) { throw 'Invalid Continente search page.' }
    $attrs = @{}
    foreach ($attr in [regex]::Matches($footers[0].Groups[1].Value, '([\w-]+)\s*=\s*["'']([^"'']*)["'']')) { $attrs[$attr.Groups[1].Value] = $attr.Groups[2].Value }
    foreach ($key in @('data-total-count','data-page-size','data-page-number')) {
        if (-not $attrs.ContainsKey($key)) { throw 'Invalid Continente search page.' }
    }
    $totalRaw = [string]$attrs['data-total-count']
    $sizeRaw = [string]$attrs['data-page-size']
    $numberRaw = [string]$attrs['data-page-number']
    if ($totalRaw -notmatch '^(0|[1-9]\d*)$' -or $numberRaw -notmatch '^(0|[1-9]\d*)$') { throw 'Invalid Continente search page.' }
    $sizeValue = 0.0
    if (-not [double]::TryParse($sizeRaw, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$sizeValue) -or $sizeValue -le 0 -or $sizeValue -ne [Math]::Floor($sizeValue)) {
        throw 'Invalid Continente search page.'
    }
    return [pscustomobject]@{totalCount=[int]$totalRaw; pageSize=[int]$sizeValue; pageNumber=[int]$numberRaw}
}

function Get-ContinenteSearchProductUrls([string]$Body, [string]$Origin) {
    $found = [ordered]@{}
    $tiles = @([regex]::Matches($Body, '(?is)<div class="product" data-pid="(\d+)">'))
    for ($i = 0; $i -lt $tiles.Count; $i++) {
        $sku = $tiles[$i].Groups[1].Value
        $chunkStart = $tiles[$i].Index + $tiles[$i].Length
        $chunkEnd = if ($i + 1 -lt $tiles.Count) { $tiles[$i + 1].Index } else { $Body.Length }
        $chunk = $Body.Substring($chunkStart, $chunkEnd - $chunkStart)
        $link = [regex]::Match($chunk, '(?is)href\s*=\s*["'']([^"'']*?/produto/[^/"''?#]+-' + [regex]::Escape($sku) + '\.html)(?:[?#][^"'']*)?["'']')
        if (-not $link.Success) { throw 'Invalid Continente search page.' }
        $href = $link.Groups[1].Value
        if ($href.StartsWith('/')) { $href = "$Origin$href" }
        $productUri = $null
        if (-not [Uri]::TryCreate($href, [UriKind]::Absolute, [ref]$productUri) -or $productUri.Scheme -ne 'https') { throw 'Invalid Continente search page.' }
        if ($productUri.Host -notin @('continente.pt','www.continente.pt')) { throw 'Invalid Continente search page.' }
        if ($productUri.AbsolutePath -notmatch '^/produto/[^/]+-(\d+)\.html$' -or $Matches[1] -ne $sku) { throw 'Invalid Continente search page.' }
        if (-not $found.Contains($sku)) { $found[$sku] = "$Origin$($productUri.AbsolutePath)" }
    }
    return @($found.GetEnumerator() | ForEach-Object { [pscustomobject]@{sku=$_.Key; url=$_.Value} })
}

function Get-ContinenteSearchPageUrl($Source, [int]$Start) {
    $uri = [Uri]$Source.url
    $selected = @{}
    $raw = $uri.Query.TrimStart('?')
    if ($raw) {
        foreach ($part in $raw.Split('&')) {
            if ($part.Length -eq 0) { continue }
            $eq = $part.IndexOf('=')
            if ($eq -lt 0) { $name = $part; $value = '' } else { $name = $part.Substring(0, $eq); $value = $part.Substring($eq + 1) }
            $selected[$name] = $value
        }
    }
    $selected['start'] = [string]$Start
    $query = (($selected.Keys | Sort-Object) | ForEach-Object { "$_=$($selected[$_])" }) -join '&'
    return "https://www.continente.pt/pesquisa/?$query"
}

function Get-Changes($Products, $Known, [bool]$IncludeRestocks, [string]$Origin = 'https://geekhaven.pt') {
    foreach ($product in $Products) {
        $id = [string]$product.id
        $available = Get-Availability $product
        $kind = $null
        if (-not $Known.ContainsKey($id)) { $kind = 'NEW PRODUCT' }
        elseif ($IncludeRestocks -and $available -and $Known[$id].available -is [bool] -and -not $Known[$id].available) { $kind = 'RESTOCK' }
        if ($kind) {
            $url = if ($product.url) { $product.url } else { "$Origin/products/$($product.handle)" }
            [pscustomobject]@{kind=$kind; title=$product.title; available=$available; url=$url}
        }
    }
}

function Read-SourceHistory($Saved) {
    $history = @{}
    if ($Saved.version -eq 1) {
        $history['https://geekhaven.pt/collections/pokemon'] = @{initialized=$true; products=@{}; etag=$null; failures=0; nextCheck=[datetime]::MinValue}
        foreach ($entry in $Saved.products) { $history['https://geekhaven.pt/collections/pokemon'].products[[string]$entry.id] = $entry }
    } elseif ($Saved.version -eq 2) {
        foreach ($source in $Saved.sources) {
            $known = @{}
            foreach ($entry in $source.products) { $known[[string]$entry.id] = $entry }
            $history[$source.url] = @{initialized=$true; products=$known; etag=$null; failures=0; nextCheck=[datetime]::MinValue}
        }
    } else { throw 'Unsupported state format.' }
    return $history
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

$history = @{}
if (Test-Path -LiteralPath $StatePath) {
    try { $history = Read-SourceHistory (Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json) }
    catch { throw "Cannot read saved history at $StatePath. Restore it or rename it to create a fresh baseline. $_" }
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
    Write-Host "Watching configured sources every $IntervalSeconds seconds. Ctrl+C stops. Keep this terminal and PC awake."
    Write-Host "History: $StatePath"
    do {
        $alertConfig = Update-AlertConfig $ConfigPath $alertConfig
        if (-not $intervalOverride) { $IntervalSeconds = $alertConfig.intervalSeconds }
        foreach ($sourceUrl in $alertConfig.sources) {
        $source = Get-Source $sourceUrl
        if (-not $history.ContainsKey($source.url)) {
            $history[$source.url] = @{initialized=$false; products=@{}; etag=$null; failures=0; nextCheck=[datetime]::MinValue}
        }
        $sourceState = $history[$source.url]
        if ([datetime]::UtcNow -lt $sourceState.nextCheck) { continue }
        $known = $sourceState.products
        $initialized = $sourceState.initialized
        $etag = $sourceState.etag
        $failures = $sourceState.failures
        $delay = $IntervalSeconds
        try {
            $products = @()
            $page = 1
            $nextEtag = $null
            $unchanged = $false
            $mockRoot = $null
            if ($MockResponsePath) { $mockRoot = Get-Content -LiteralPath $MockResponsePath -Raw | ConvertFrom-Json }
            $send = {
                param($RequestUrl, [bool]$UseEtag)
                $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, $RequestUrl)
                if ($UseEtag -and $etag) { $request.Headers.TryAddWithoutValidation('If-None-Match', $etag) | Out-Null }
                $response = $null
                try {
                    if ($MockResponsePath) {
                        $fixture = $mockRoot
                        if ($fixture.sources) {
                            $fixture = $fixture.sources.PSObject.Properties[$source.url].Value
                            if ($null -eq $fixture) { throw 'Missing source mock response.' }
                        }
                        $mapped = $null
                        if ($fixture.PSObject.Properties['responses']) { $mapped = $fixture.responses.PSObject.Properties[$RequestUrl].Value }
                        if ($null -ne $mapped) { $fixture = $mapped }
                        elseif ($RequestUrl -ne $source.endpoint -and $RequestUrl -ne $source.url -and $source.kind -eq 'continente-search') {
                            throw "Missing mock response for $RequestUrl"
                        }
                        $mockStatus = [Enum]::ToObject([System.Net.HttpStatusCode], [int]$fixture.status)
                        $response = New-Object System.Net.Http.HttpResponseMessage($mockStatus)
                        $response.Content = New-Object System.Net.Http.StringContent([string]$fixture.body)
                        if ($fixture.retryAfter) { $response.Headers.TryAddWithoutValidation('Retry-After', [string]$fixture.retryAfter) | Out-Null }
                    } else {
                        $response = $client.SendAsync($request).GetAwaiter().GetResult()
                    }
                    $status = [int]$response.StatusCode
                    if ($status -eq 304) { return [pscustomobject]@{unchanged=$true} }
                    if ($status -in @(401,403)) { throw "STOP: HTTP $status. Access denied; monitor will not attempt to bypass it." }
                    if (-not $response.IsSuccessStatusCode) {
                        Set-Variable -Name delay -Value (Get-RetryDelay $response ($failures + 1)) -Scope 1
                        throw "HTTP $status"
                    }
                    $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
                    $responseEtag = if ($response.Headers.ETag) { $response.Headers.ETag.ToString() } else { $null }
                    return [pscustomobject]@{unchanged=$false; body=$body; etag=$responseEtag}
                } finally {
                    if ($response) { $response.Dispose() }
                    $request.Dispose()
                }
            }
            if ($source.kind -eq 'continente-search') {
                $detailUrls = [ordered]@{}
                $initialStart = 0
                $expectedTotal = $null
                $sourceUri = [Uri]$source.url
                $startMatch = [regex]::Match($sourceUri.Query, '(?i)(?:\?|&)start=([^&]*)')
                if ($startMatch.Success) { $initialStart = [int][Uri]::UnescapeDataString($startMatch.Groups[1].Value.Replace('+',' ')) }
                $start = $initialStart
                for ($listingPage = 1; ; $listingPage++) {
                    if ($listingPage -gt 5) { throw 'Continente search exceeded 5 listing pages; history not changed.' }
                    $requestUrl = if ($listingPage -eq 1) { $source.endpoint } else { Get-ContinenteSearchPageUrl $source $start }
                    $result = & $send $requestUrl $false
                    if ($result.unchanged) { throw 'Unexpected Continente search HTTP 304.' }
                    $footer = Get-ContinenteSearchFooter $result.body
                    if ($start -ne ($footer.pageNumber * $footer.pageSize)) { throw 'Invalid Continente search page.' }
                    if ($null -eq $expectedTotal) { $expectedTotal = $footer.totalCount }
                    elseif ($footer.totalCount -ne $expectedTotal) { throw 'Invalid Continente search page.' }
                    $links = @(Get-ContinenteSearchProductUrls $result.body $source.origin)
                    if ($footer.totalCount -eq 0) {
                        if ($links.Count -ne 0) { throw 'Invalid Continente search page.' }
                        break
                    }
                    if ($links.Count -eq 0) { throw 'Invalid Continente search page.' }
                    foreach ($link in $links) {
                        if ($detailUrls.Contains($link.sku)) { continue }
                        if ($detailUrls.Count -ge 30) { throw 'Continente search exceeded 30 products; history not changed.' }
                        $detailUrls[$link.sku] = $link.url
                    }
                    $nextStart = $start + $footer.pageSize
                    if ($nextStart -ge $footer.totalCount) { break }
                    $start = $nextStart
                    if (-not $MockResponsePath) { Start-Sleep -Seconds $IntervalSeconds }
                }
                if ($null -eq $expectedTotal) { throw 'Invalid Continente search page.' }
                if ($detailUrls.Count -ne ($expectedTotal - $initialStart)) { throw 'Continente search product count mismatch; history not changed.' }
                if ($detailUrls.Count -gt 30) { throw 'Continente search exceeded 30 products; history not changed.' }
                $pdpIndex = 0
                foreach ($entry in $detailUrls.GetEnumerator()) {
                    $pdpSource = Get-Source $entry.Value
                    $result = & $send $entry.Value $false
                    if ($result.unchanged) { throw 'Unexpected Continente product HTTP 304.' }
                    $products += @(Convert-SourceBody $result.body $pdpSource)
                    $pdpIndex++
                    if (-not $MockResponsePath -and $pdpIndex -lt $detailUrls.Count) { Start-Sleep -Seconds 1 }
                }
                $nextEtag = $null
            } else {
                do {
                    $requestUrl = if ($source.kind -eq 'collection') { "$($source.endpoint)?limit=250&page=$page" } else { $source.endpoint }
                    $result = & $send $requestUrl ($page -eq 1)
                    if ($result.unchanged) { $unchanged = $true; break }
                    $batch = @(Convert-SourceBody $result.body $source)
                    $products += $batch
                    if ($page -eq 1 -and $batch.Count -lt 250 -and $result.etag) { $nextEtag = $result.etag }
                    if ($source.kind -ne 'collection' -or $batch.Count -lt 250) { break }
                    $page++
                    if ($page -gt 100) { throw 'Pagination exceeded safety limit; history not changed.' }
                    Start-Sleep -Seconds $IntervalSeconds
                } while ($true)
            }

            if (-not $unchanged) {
                $changes = @()
                if ($initialized) { $changes = @(Get-Changes $products $known (-not $NewOnly) $source.origin) }
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
                    $known[$id] = [pscustomobject]@{id=$id; available=(Get-Availability $product)}
                }
                # Retain IDs of removed products so reordering/removal doesn't create false new alerts.
                $sourceState.initialized = $true
                $savedSources = @($history.Keys | Where-Object { $history[$_].initialized } | ForEach-Object { @{url=$_; products=@($history[$_].products.Values)} })
                $json = @{version=2; sources=$savedSources} | ConvertTo-Json -Depth 8
                Save-History $StatePath $json
                if (-not $initialized) { Write-Host "Baseline saved: $($products.Count) products. Future additions will alert." }
                $initialized = $true
                $sourceState.etag = $nextEtag
            }
            $sourceState.failures = 0
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Check OK$(if ($unchanged) { ' (unchanged)' })."
        } catch {
            if ($_.Exception.Message.StartsWith('STOP:') -and $alertConfig.sources.Count -eq 1) { throw }
            $failures++
            $sourceState.failures = $failures
            $delay = [Math]::Max($delay, [Math]::Min(900,30 * [Math]::Pow(2,[Math]::Min($failures - 1,5))))
            Write-Warning "$($source.url) check failed: $($_.Exception.Message). Retrying in $delay seconds."
            if ($Once -and $alertConfig.sources.Count -eq 1) { throw }
        }
        $sourceState.nextCheck = [datetime]::UtcNow.AddSeconds($delay)
        }
        if (-not $Once) { Start-Sleep -Seconds $IntervalSeconds }
    } while (-not $Once)
} finally {
    if ($client) { $client.Dispose() }
    if ($lock) { $lock.Dispose() }
}
