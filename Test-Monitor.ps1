$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\Watch-Pokemon.ps1"
$p = [pscustomobject]@{id=1;title='Test';handle='test';variants=@([pscustomobject]@{available=$true})}
if (@(Get-Changes @($p) @{} $true).Count -ne 1) { throw 'New detection failed' }
$k = @{'1'=[pscustomobject]@{available=$false}}
if ((Get-Changes @($p) $k $true).kind -ne 'RESTOCK') { throw 'Restock failed' }
if (@(Get-Changes @($p) $k $false).Count -ne 0) { throw 'NewOnly failed' }
$k['1'].available = $true
if (@(Get-Changes @($p) $k $true).Count -ne 0) { throw 'Duplicate alert' }
$r = New-Object System.Net.Http.HttpResponseMessage
$r.Headers.TryAddWithoutValidation('Retry-After','1800') | Out-Null
if ((Get-RetryDelay $r 1) -ne 1800) { throw 'Retry-After failed' }
$r.Dispose()
$testPath = Join-Path $PSScriptRoot ('test-state-' + [guid]::NewGuid().ToString() + '.json')
try {
    foreach ($number in @(1,2,3)) {
        Save-History $testPath (@{version=1; products=@(); check=$number} | ConvertTo-Json)
        $result = Get-Content -LiteralPath $testPath -Raw | ConvertFrom-Json
        if ($result.check -ne $number) { throw 'History save failed' }
    }
    $backup = Get-Content -LiteralPath "$testPath.bak" -Raw | ConvertFrom-Json
    if ($backup.check -ne 2) { throw 'History backup failed' }
} finally {
    foreach ($path in @($testPath, "$testPath.tmp", "$testPath.bak")) {
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
    }
}
Write-Host 'PASS: initial history save, repeated replacement, previous-history backup.'
Write-Host 'PASS: new products, restocks, NewOnly, duplicate suppression, Retry-After.'
$configTest = Join-Path $PSScriptRoot ('test-config-' + [guid]::NewGuid().ToString() + '.json')
try {
    foreach ($volume in @(0,40,100)) {
        @{soundFile='level-up-ringtone.mp3';volume=$volume} | ConvertTo-Json | Set-Content -LiteralPath $configTest
        $settings = Read-AlertConfig $configTest
        if ($settings.volume -ne $volume -or $settings.soundFile -ne (Join-Path $PSScriptRoot 'level-up-ringtone.mp3')) { throw 'Config resolution failed.' }
    }
    foreach ($volume in @(-1,101,1.5,'loud',$null)) {
        @{soundFile='level-up-ringtone.mp3';volume=$volume} | ConvertTo-Json | Set-Content -LiteralPath $configTest
        $rejected = $false
        try { $null = Read-AlertConfig $configTest } catch { $rejected = $true }
        if (-not $rejected) { throw 'Invalid volume accepted.' }
    }
    @{soundFile='nonexistent-test-sound.mp3';volume=50} | ConvertTo-Json | Set-Content -LiteralPath $configTest
    $rejected = $false
    try { $null = Read-AlertConfig $configTest } catch { $rejected = $true }
    if (-not $rejected) { throw 'Missing sound accepted.' }
} finally {
    if (Test-Path -LiteralPath $configTest) { Remove-Item -LiteralPath $configTest }
}
Write-Host 'PASS: config paths, volume boundaries, invalid settings, missing sound.'
