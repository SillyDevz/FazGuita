param([switch]$MuteSound)
$ErrorActionPreference = 'Stop'
$monitor = Join-Path $PSScriptRoot 'Watch-Pokemon.ps1'
$prefix = Join-Path $PSScriptRoot ('mock-test-' + [guid]::NewGuid().ToString())
$state = "$prefix-state.json"
$fixturePath = "$prefix-response.json"

function Set-Response($Products, [int]$Status = 200, [string]$RawBody = '', [string]$RetryAfter = '') {
    $body = if ($RawBody) { $RawBody } else { @{products=@($Products)} | ConvertTo-Json -Depth 10 }
    @{status=$Status; body=$body; retryAfter=$RetryAfter} | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $fixturePath -Encoding UTF8
}
function Invoke-Mock([switch]$Silent, [switch]$OnlyNew) {
    $lines = & $monitor -Once -MockResponsePath $fixturePath -StatePath $state -MockMute:($Silent -or $MuteSound) -NewOnly:$OnlyNew 6>&1 3>&1
    $output = ($lines | ForEach-Object { $_.ToString() }) -join "`n"
    Write-Host $output
    return $output
}
function Assert-Contains([string]$Text, [string]$Value) {
    if (-not $Text.Contains($Value)) { throw "Expected output: $Value. Actual: $Text" }
}
function Assert-NoAlert([string]$Text) {
    if ($Text -match '\[(NEW PRODUCT|RESTOCK)\]|Alert sound played|MOCK: sound suppressed') { throw 'Unexpected duplicate/baseline alert.' }
}
function Assert-Failure([string]$Expected) {
    $before = [IO.File]::ReadAllText($state)
    $caught = $false
    try { $null = Invoke-Mock -Silent } catch {
        $caught = $true
        Assert-Contains $_.Exception.Message $Expected
    }
    if (-not $caught) { throw "Expected failure: $Expected" }
    if ([IO.File]::ReadAllText($state) -ne $before) { throw 'Failed response changed history.' }
}

try {
    $existing = [pscustomobject]@{id=900001; title='MOCK Existing Booster'; handle='mock-existing'; variants=@(@{available=$false})}
    $new = [pscustomobject]@{id=900002; title='MOCK New Elite Trainer Box'; handle='mock-new'; variants=@(@{available=$true})}
    Write-Host '1. First response: save baseline with no alert.' -ForegroundColor Cyan
    Set-Response @($existing)
    Assert-NoAlert (Invoke-Mock -Silent)

    Write-Host '2. New product plus restock: expect two messages and one five-play sound sequence.' -ForegroundColor Cyan
    $existing.variants[0].available = $true
    Set-Response @($existing,$new)
    $output = Invoke-Mock
    Assert-Contains $output '[NEW PRODUCT] MOCK New Elite Trainer Box'
    Assert-Contains $output '[RESTOCK] MOCK Existing Booster'
    if (-not $MuteSound) { Assert-Contains $output 'Alert sound played 5 times.' }
    $history = Get-Content -LiteralPath $state -Raw | ConvertFrom-Json
    if ($history.products.Count -ne 2) { throw 'New product not saved.' }

    Write-Host '3. Same response after restart: no duplicate alert.' -ForegroundColor Cyan
    Assert-NoAlert (Invoke-Mock -Silent)
    Write-Host '4. HTTP 304: unchanged, no alert.' -ForegroundColor Cyan
    Set-Response @() 304
    Assert-NoAlert (Invoke-Mock -Silent)
    Write-Host '5. HTTP 429, denied access, and malformed JSON preserve history.' -ForegroundColor Cyan
    Set-Response @() 429 '' '1800'
    Assert-Failure 'HTTP 429'
    Set-Response @() 403
    Assert-Failure 'STOP: HTTP 403'
    Set-Response @() 200 '{broken'
    Assert-Failure 'Invalid'
    Write-Host '6. NewOnly ignores restocks but still detects new sold-out products.' -ForegroundColor Cyan
    $existing.variants[0].available = $false
    Set-Response @($existing,$new)
    Assert-NoAlert (Invoke-Mock -Silent)
    $existing.variants[0].available = $true
    $soldOut = @{id=900003;title='MOCK New Sold Out Box';handle='mock-sold-out';variants=@(@{available=$false})}
    Set-Response @($existing,$new,$soldOut)
    $output = Invoke-Mock -Silent -OnlyNew
    Assert-Contains $output '[NEW PRODUCT] MOCK New Sold Out Box (SOLD OUT)'
    if ($output.Contains('[RESTOCK]')) { throw 'NewOnly emitted a restock.' }
    Write-Host 'PASS: all mock request scenarios. Real history was not used.' -ForegroundColor Green
} finally {
    foreach ($path in @($fixturePath,$state,"$state.tmp","$state.bak","$state.lock")) {
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
    }
}
