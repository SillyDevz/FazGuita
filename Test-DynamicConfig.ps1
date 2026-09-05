$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\Watch-Pokemon.ps1"
$path = Join-Path $PSScriptRoot ('config-test-' + [guid]::NewGuid().ToString() + '.json')
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }
try {
    $data = @{soundFile='level-up-ringtone.mp3';volume=40}
    $data | ConvertTo-Json | Set-Content -LiteralPath $path
    $settings = Read-AlertConfig $path
    $changes = @(
        [pscustomobject]@{kind='NEW PRODUCT';title='Booster Box JP';available=$true},
        [pscustomobject]@{kind='NEW PRODUCT';title='Elite Trainer Box';available=$false},
        [pscustomobject]@{kind='RESTOCK';title='Booster Pack';available=$true}
    )
    Assert (@(Select-Alerts $changes $settings).Count -eq 3) 'Defaults changed.'
    $settings.alertOnNewProducts = $false
    Assert (@(Select-Alerts $changes $settings).Count -eq 1) 'New product toggle failed.'
    $settings.alertOnNewProducts = $true
    $settings.alertOnRestocks = $false
    $settings.alertOnSoldOutListings = $false
    Assert (@(Select-Alerts $changes $settings).Count -eq 1) 'Stock event toggles failed.'
    $settings.alertOnRestocks = $true
    $settings.includeKeywords = @('bOoStEr','Trainer')
    $settings.excludeKeywords = @('jp')
    Assert (@(Select-Alerts $changes $settings)[0].title -eq 'Booster Pack') 'Keyword filters failed.'
    $settings.includeKeywords = @('does not match')
    Assert (@(Select-Alerts $changes $settings).Count -eq 0) 'Unmatched keyword passed.'
    $data.soundRepeats = 3
    $data.intervalSeconds = 25
    $data.openBrowserOnAlert = $true
    $data | ConvertTo-Json | Set-Content -LiteralPath $path
    $settings = Update-AlertConfig $path $settings
    Assert ($settings.soundRepeats -eq 3 -and $settings.intervalSeconds -eq 25 -and $settings.openBrowserOnAlert) 'Config reload failed.'
    '{broken' | Set-Content -LiteralPath $path
    $retained = Update-AlertConfig $path $settings 3>$null
    Assert ($retained -eq $settings) 'Invalid edit lost the last valid settings.'
    foreach ($pair in @(@('soundRepeats',0),@('intervalSeconds',9),@('alertOnRestocks','true'),@('includeKeywords','box'))) {
        $invalid = $data.Clone()
        $invalid[$pair[0]] = $pair[1]
        $invalid | ConvertTo-Json | Set-Content -LiteralPath $path
        $rejected = $false
        try { $null = Read-AlertConfig $path } catch { $rejected = $true }
        Assert $rejected "Invalid $($pair[0]) accepted."
    }
    # Record playback commands instead of playing audio in this test process.
    Add-Type -TypeDefinition @'
namespace PokemonMonitor {
    public static class Audio {
        public static System.Collections.Generic.List<string> Commands = new System.Collections.Generic.List<string>();
        public static void Send(string command) { Commands.Add(command); }
    }
}
'@
    $alertConfig = $settings
    Play-Alert
    $commands = [PokemonMonitor.Audio]::Commands
    Assert ($commands.Contains('setaudio pokemonAlert volume to 400')) 'Volume scaling failed.'
    Assert (@($commands | Where-Object { $_ -eq 'play pokemonAlert from 0 wait' }).Count -eq 3) 'Repeat count failed.'
    $commands.Clear()
    $alertConfig.volume = 0
    Play-Alert
    Assert ($commands.Count -eq 0) 'Muted alert attempted audio playback.'
    Write-Host 'PASS: event toggles, keyword filters, live reload, invalid-edit recovery, validation, volume, repeats, mute.'
} finally {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
}
