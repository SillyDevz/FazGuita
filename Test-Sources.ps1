$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Watch-Pokemon.ps1"
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }
function Reject($Action) { $failed=$false; try { & $Action } catch { $failed=$true }; Assert $failed 'Expected rejection.' }
$shop = Get-Source 'https://example.com/collections/cards/products.json?sort=x#top'
Assert ($shop.url -eq 'https://example.com/collections/cards') 'Collection canonicalization failed.'
Assert ((Get-Source 'https://example.com/products/box').endpoint -eq 'https://example.com/products/box.json') 'Product endpoint failed.'
foreach ($url in @('http://example.com/products/box','https://user:pass@example.com/products/box','https://example.com/search','https://www.continente.pt/pesquisa','https://www.continente.pt/pesquisa/?q=%20')) { Reject { Get-Source $url } }
$search = Get-Source 'https://continente.pt/pesquisa/?utm=1&srule=Continente&q=pokemon+tcg&start=0&pmin=0.01#frag'
Assert ($search.kind -eq 'continente-search') 'Search kind failed.'
Assert ($search.url -eq 'https://www.continente.pt/pesquisa/?pmin=0.01&q=pokemon%20tcg&srule=Continente&start=0') 'Search canonicalization failed.'
Assert ((Get-Source 'https://www.continente.pt/pesquisa?q=pokemon').url -eq 'https://www.continente.pt/pesquisa/?q=pokemon') 'Search path must keep trailing slash.'
Reject { Get-Source 'https://www.continente.pt/pesquisa/?q=pokemon&q=cards' }
Reject { Get-Source 'https://www.continente.pt/pesquisa/?q=pokemon&start=-1' }
Reject { Get-Source 'https://www.continente.pt/pesquisa/?q=pokemon&sz=0' }
$product = @{id=1;title='Box';handle='box';variants=@(@{available=$true})}
Assert ((Get-Changes @($product) @{} $true $shop.origin).url -eq 'https://example.com/products/box') 'Wrong origin.'
foreach ($value in @('true',1,$null)) { $product.variants[0].available=$value; Reject { Get-Changes @($product) @{'1'=@{available=$false}} $true } }
$product.variants=@(@{}); Reject { Get-Availability $product }
$source = Get-Source 'https://www.continente.pt/produto/cards-8883406.html'
function Html($Availability='https://schema.org/InStock') {
    '<script type="application/ld+json">' + (@{'@graph'=@(@{'@type'='Product';sku='123';name='Recommendation';offers=@{availability='https://schema.org/OutOfStock'}},@{'@type'='Product';sku='8883406';name='Cards';offers=@{availability=$Availability}})} | ConvertTo-Json -Depth 8 -Compress) + '</script>'
}
Assert ((Convert-SourceBody (Html) $source).variants[0].available) 'Matching structured product missed.'
Assert (-not (Convert-SourceBody (Html 'https://schema.org/SoldOut') $source).variants[0].available) 'SoldOut missed.'
Reject { Convert-SourceBody (Html 'https://schema.org/PreOrder') $source }
Reject { Convert-SourceBody (Html $null) $source }
$button='<button data-container="pdp" data-pid="8883406" data-outofstock="true">'
Assert (-not (Convert-SourceBody ((Html)+$button) $source).variants[0].available) 'PDP sold-out override missed.'
Assert ((Convert-SourceBody ((Html)+$button.Replace('8883406','123')) $source).variants[0].available) 'Recommendation button affected stock.'
Reject { Convert-SourceBody ((Html)+$button.Replace('true','unknown')) $source }
Assert (-not (Convert-SourceBody ((Html)+'<button data-container="pdp" data-pid="8883406" disabled data-outofstock="false">') $source).variants[0].available) 'Disabled PDP button missed.'
Reject { Convert-SourceBody ((Html)+(Html)) $source }
$conflict='<script type="application/ld+json">{"@type":"Product","sku":"8883406","name":"Cards","offers":[{"availability":"https://schema.org/InStock"},{"availability":"https://schema.org/OutOfStock"}]}</script>'
Reject { Convert-SourceBody $conflict $source }
$oosSource = Get-Source 'https://www.continente.pt/produto/raging-surf-8883689.html'
$realPdp = Get-Content -LiteralPath '/tmp/fazguita-continente-product.html' -Raw
Assert (-not (Convert-SourceBody $realPdp $oosSource).variants[0].available) 'Primary OOS wrapper should win over InStock JSON-LD/button.'
$otherSku = Get-Source 'https://www.continente.pt/produto/other-9999999.html'
Reject { Convert-SourceBody $realPdp $otherSku }
$wrapper = '<div class="row product-detail product-wrapper" data-pid="8883406" data-is-product-out-of-stock="true">'
Assert (-not (Convert-SourceBody ((Html)+$wrapper) $source).variants[0].available) 'Matching primary OOS wrapper missed.'
Assert ((Convert-SourceBody ((Html)+$wrapper.Replace('8883406','123')) $source).variants[0].available) 'Other SKU wrapper affected stock.'
Reject { Convert-SourceBody ((Html)+$wrapper.Replace('true','maybe')) $source }
$classOnly = '<div class="row product-detail product-wrapper product-out-of-stock" data-pid="8883406">'
Assert (-not (Convert-SourceBody ((Html)+$classOnly) $source).variants[0].available) 'product-out-of-stock class should force OOS without attr.'
$classWins = '<div class="row product-detail product-wrapper product-out-of-stock" data-pid="8883406" data-is-product-out-of-stock="false">'
Assert (-not (Convert-SourceBody ((Html)+$classWins+'<button data-container="pdp" data-pid="8883406" data-outofstock="false">') $source).variants[0].available) 'product-out-of-stock class must win over false attr/button.'
$realSearch = Get-Content -LiteralPath '/tmp/fazguita-continente-search.html' -Raw
$footer = Get-ContinenteSearchFooter $realSearch
Assert ($footer.totalCount -eq 14 -and $footer.pageSize -eq 35 -and $footer.pageNumber -eq 0) 'Live search footer mismatch.'
$links = @(Get-ContinenteSearchProductUrls $realSearch 'https://www.continente.pt')
Assert ($links.Count -eq 14) 'Live search tile discovery count mismatch.'
Assert (($links | Select-Object -ExpandProperty sku -Unique).Count -eq 14) 'Search SKU dedup failed on live page.'
Assert ($links[0].url -match '^https://www\.continente\.pt/produto/.+-8883406\.html$') 'First search tile URL mismatch.'
$emptyFooter = '<div class="grid-footer" data-total-count="0" data-page-size="35" data-page-number="0"></div>'
Assert ((Get-ContinenteSearchFooter $emptyFooter).totalCount -eq 0) 'Zero-result footer rejected.'
Assert (@(Get-ContinenteSearchProductUrls $emptyFooter 'https://www.continente.pt').Count -eq 0) 'Zero-result body should discover no tiles.'
Reject { Get-ContinenteSearchFooter '<div class="grid-footer" data-total-count="x" data-page-size="35" data-page-number="0"></div>' }
Reject { Get-ContinenteSearchFooter '<div>no footer</div>' }
$dupTiles = '<div class="product" data-pid="1"><a href="/produto/a-1.html"></a></div><div class="product" data-pid="1"><a href="/produto/b-1.html"></a></div><div class="grid-footer" data-total-count="1" data-page-size="35.0" data-page-number="0"></div>'
Assert (@(Get-ContinenteSearchProductUrls $dupTiles 'https://www.continente.pt').Count -eq 1) 'Duplicate SKU tiles should dedup.'
$page2 = Get-ContinenteSearchPageUrl $search 35
Assert ($page2 -eq 'https://www.continente.pt/pesquisa/?pmin=0.01&q=pokemon%20tcg&srule=Continente&start=35') 'Pagination URL lost filters.'
$legacy = Read-SourceHistory ([pscustomobject]@{version=1;products=@(@{id='1';available=$false})})
Assert ($legacy['https://geekhaven.pt/collections/pokemon'].initialized -and $legacy['https://geekhaven.pt/collections/pokemon'].products.ContainsKey('1')) 'Legacy migration failed.'
$prefix=Join-Path $PSScriptRoot ('sources-test-'+[guid]::NewGuid())
$configPath="$prefix-config.json"; $statePath="$prefix-state.json"; $fixturePath="$prefix-fixture.json"
try {
    $config=@{sources=@($shop.url,$source.url); soundFile='level-up-ringtone.mp3';volume=0}
    $config | ConvertTo-Json -Depth 8 | Set-Content $configPath
    $fixtures=@{sources=@{}}
    $fixtures.sources[$shop.url]=@{status=403;body=''}
    $fixtures.sources[$source.url]=@{status=200;body=(Html 'https://schema.org/OutOfStock')}
    $fixtures | ConvertTo-Json -Depth 10 | Set-Content $fixturePath
    $output=(& "$PSScriptRoot/Watch-Pokemon.ps1" -Once -MockMute -ConfigPath $configPath -StatePath $statePath -MockResponsePath $fixturePath 6>&1 3>&1 | Out-String)
    Assert ($output -notmatch '\[RESTOCK\]|\[NEW PRODUCT\]') 'New source baseline alerted.'
    $saved=Get-Content $statePath -Raw | ConvertFrom-Json
    Assert ($saved.sources.Count -eq 1 -and $saved.sources[0].url -eq $source.url) '403 prevented other source baseline.'
    $fixtures.sources[$source.url].body=Html
    $fixtures | ConvertTo-Json -Depth 10 | Set-Content $fixturePath
    $output=(& "$PSScriptRoot/Watch-Pokemon.ps1" -Once -MockMute -ConfigPath $configPath -StatePath $statePath -MockResponsePath $fixturePath 6>&1 3>&1 | Out-String)
    Assert ($output -match '\[RESTOCK\] Cards') '403 prevented other source restock.'
    $before=Get-Content $statePath -Raw
    $fixtures.sources[$source.url].body=Html 'https://schema.org/Unknown'
    $fixtures | ConvertTo-Json -Depth 10 | Set-Content $fixturePath
    $null=& "$PSScriptRoot/Watch-Pokemon.ps1" -Once -MockMute -ConfigPath $configPath -StatePath $statePath -MockResponsePath $fixturePath 6>&1 3>&1
    Assert ((Get-Content $statePath -Raw) -eq $before) 'Unknown stock changed state.'

    $searchUrl = $search.url
    $pdpUrl = 'https://www.continente.pt/produto/cards-1.html'
    $listing = '<div class="product" data-pid="1"><a href="/produto/cards-1.html"></a></div><div class="grid-footer" data-total-count="1" data-page-size="35" data-page-number="0"></div>'
    $pdpHtml = '<script type="application/ld+json">{"@type":"Product","sku":"1","name":"Search Card","offers":{"availability":"https://schema.org/OutOfStock"}}</script>'
    $searchConfigPath="$prefix-search-config.json"; $searchState="$prefix-search-state.json"; $searchFixture="$prefix-search-fixture.json"
    @{sources=@($searchUrl); soundFile='level-up-ringtone.mp3';volume=0; intervalSeconds=10} | ConvertTo-Json -Depth 5 | Set-Content $searchConfigPath
    $searchFixtures=@{sources=@{}}
    $searchFixtures.sources[$searchUrl]=@{
        status=200
        body=$listing
        responses=@{ $pdpUrl = @{status=200; body=$pdpHtml} }
    }
    $searchFixtures | ConvertTo-Json -Depth 12 | Set-Content $searchFixture
    $output=(& "$PSScriptRoot/Watch-Pokemon.ps1" -Once -MockMute -ConfigPath $searchConfigPath -StatePath $searchState -MockResponsePath $searchFixture 6>&1 3>&1 | Out-String)
    Assert ($output -notmatch '\[RESTOCK\]|\[NEW PRODUCT\]') 'Search baseline alerted.'
    $saved=Get-Content $searchState -Raw | ConvertFrom-Json
    Assert ($saved.sources[0].products[0].available -eq $false) 'Search baseline stock wrong.'
    $searchFixtures.sources[$searchUrl].responses[$pdpUrl].body = $pdpHtml.Replace('OutOfStock','InStock')
    $searchFixtures | ConvertTo-Json -Depth 12 | Set-Content $searchFixture
    $output=(& "$PSScriptRoot/Watch-Pokemon.ps1" -Once -MockMute -ConfigPath $searchConfigPath -StatePath $searchState -MockResponsePath $searchFixture 6>&1 3>&1 | Out-String)
    Assert ($output -match '\[RESTOCK\] Search Card') 'Search PDP restock missed.'
    $before=Get-Content $searchState -Raw
    $searchFixtures.sources[$searchUrl].responses[$pdpUrl].body = 'not-a-product'
    $searchFixtures | ConvertTo-Json -Depth 12 | Set-Content $searchFixture
    try { $null=& "$PSScriptRoot/Watch-Pokemon.ps1" -Once -MockMute -ConfigPath $searchConfigPath -StatePath $searchState -MockResponsePath $searchFixture 6>&1 3>&1 } catch { }
    Assert ((Get-Content $searchState -Raw) -eq $before) 'Failed PDP changed search history.'

    $searchFixtures.sources[$searchUrl].body = $listing
    $searchFixtures.sources[$searchUrl].responses[$pdpUrl].body = $pdpHtml.Replace('OutOfStock','InStock')
    $searchFixtures | ConvertTo-Json -Depth 12 | Set-Content $searchFixture
    $output=(& "$PSScriptRoot/Watch-Pokemon.ps1" -Once -MockMute -ConfigPath $searchConfigPath -StatePath $searchState -MockResponsePath $searchFixture 6>&1 3>&1 | Out-String)
    Assert ($output -notmatch '\[RESTOCK\]|\[NEW PRODUCT\]') 'Unchanged search listing/PDP alerted.'

    $incomplete = '<div class="product" data-pid="1"><a href="/produto/cards-1.html"></a></div><div class="grid-footer" data-total-count="2" data-page-size="35" data-page-number="0"></div>'
    $mismatchState="$prefix-mismatch-state.json"; $mismatchFixture="$prefix-mismatch-fixture.json"; $mismatchConfig="$prefix-mismatch-config.json"
    @{sources=@($searchUrl); soundFile='level-up-ringtone.mp3';volume=0} | ConvertTo-Json | Set-Content $mismatchConfig
    $fx=@{sources=@{}}; $fx.sources[$searchUrl]=@{status=200;body=$incomplete;responses=@{ $pdpUrl=@{status=200;body=$pdpHtml} }}
    $fx | ConvertTo-Json -Depth 10 | Set-Content $mismatchFixture
    try { $null=& "$PSScriptRoot/Watch-Pokemon.ps1" -Once -MockMute -ConfigPath $mismatchConfig -StatePath $mismatchState -MockResponsePath $mismatchFixture 6>&1 3>&1 } catch { }
    Assert (-not (Test-Path $mismatchState)) 'Incomplete search totals should not write history.'

    $many = -join (1..31 | ForEach-Object { "<div class=`"product`" data-pid=`"$_`"><a href=`"/produto/x-$_.html`"></a></div>" })
    $many += '<div class="grid-footer" data-total-count="31" data-page-size="35" data-page-number="0"></div>'
    $boundState="$prefix-bound-state.json"; $boundFixture="$prefix-bound-fixture.json"; $boundConfig="$prefix-bound-config.json"
    @{sources=@($searchUrl); soundFile='level-up-ringtone.mp3';volume=0} | ConvertTo-Json | Set-Content $boundConfig
    $bound=@{sources=@{}}; $bound.sources[$searchUrl]=@{status=200;body=$many;responses=@{}}
    $bound | ConvertTo-Json -Depth 8 | Set-Content $boundFixture
    try { $null=& "$PSScriptRoot/Watch-Pokemon.ps1" -Once -MockMute -ConfigPath $boundConfig -StatePath $boundState -MockResponsePath $boundFixture 6>&1 3>&1 } catch { }
    Assert (-not (Test-Path $boundState)) 'Product bound failure should not write history.'

    $pageSearch = Get-Source 'https://www.continente.pt/pesquisa/?q=bound&start=0&sz=1'
    $pageState="$prefix-page-state.json"; $pageFixture="$prefix-page-fixture.json"; $pageConfig="$prefix-page-config.json"
    @{sources=@($pageSearch.url); soundFile='level-up-ringtone.mp3';volume=0} | ConvertTo-Json | Set-Content $pageConfig
    $responses = @{}
    for ($i=1; $i -le 5; $i++) {
        $body = "<div class=`"product`" data-pid=`"$i`"><a href=`"/produto/p-$i.html`"></a></div><div class=`"grid-footer`" data-total-count=`"6`" data-page-size=`"1`" data-page-number=`"$($i-1)`"></div>"
        if ($i -eq 1) { $firstBody = $body } else { $responses[(Get-ContinenteSearchPageUrl $pageSearch ($i-1))] = @{status=200; body=$body} }
        $responses["https://www.continente.pt/produto/p-$i.html"] = @{
            status=200
            body=('<script type="application/ld+json">{"@type":"Product","sku":"'+$i+'","name":"P'+$i+'","offers":{"availability":"https://schema.org/InStock"}}</script>')
        }
    }
    $pageFx=@{sources=@{}}; $pageFx.sources[$pageSearch.url]=@{status=200;body=$firstBody;responses=$responses}
    $pageFx | ConvertTo-Json -Depth 12 | Set-Content $pageFixture
    try { $null=& "$PSScriptRoot/Watch-Pokemon.ps1" -Once -MockMute -ConfigPath $pageConfig -StatePath $pageState -MockResponsePath $pageFixture 6>&1 3>&1 } catch { }
    Assert (-not (Test-Path $pageState)) 'Listing page bound failure should not write history.'

    $offsetSearch = Get-Source 'https://www.continente.pt/pesquisa/?q=offset&start=2'
    Assert ($offsetSearch.url -match 'start=2') 'Nonzero start dropped from canonical URL.'
    $offsetState="$prefix-offset-state.json"; $offsetFixture="$prefix-offset-fixture.json"; $offsetConfig="$prefix-offset-config.json"
    @{sources=@($offsetSearch.url); soundFile='level-up-ringtone.mp3';volume=0} | ConvertTo-Json | Set-Content $offsetConfig
    $offsetListing = '<div class="product" data-pid="3"><a href="/produto/c-3.html"></a></div><div class="product" data-pid="4"><a href="/produto/d-4.html"></a></div><div class="grid-footer" data-total-count="4" data-page-size="2" data-page-number="1"></div>'
    $offsetResponses = @{
        'https://www.continente.pt/produto/c-3.html' = @{status=200; body='<script type="application/ld+json">{"@type":"Product","sku":"3","name":"Offset Three","offers":{"availability":"https://schema.org/InStock"}}</script>'}
        'https://www.continente.pt/produto/d-4.html' = @{status=200; body='<script type="application/ld+json">{"@type":"Product","sku":"4","name":"Offset Four","offers":{"availability":"https://schema.org/OutOfStock"}}</script>'}
    }
    $offsetFx=@{sources=@{}}; $offsetFx.sources[$offsetSearch.url]=@{status=200;body=$offsetListing;responses=$offsetResponses}
    $offsetFx | ConvertTo-Json -Depth 12 | Set-Content $offsetFixture
    $output=(& "$PSScriptRoot/Watch-Pokemon.ps1" -Once -MockMute -ConfigPath $offsetConfig -StatePath $offsetState -MockResponsePath $offsetFixture 6>&1 3>&1 | Out-String)
    Assert ($output -notmatch '\[RESTOCK\]|\[NEW PRODUCT\]') 'Offset search baseline alerted.'
    $saved=Get-Content $offsetState -Raw | ConvertFrom-Json
    Assert ($saved.sources[0].products.Count -eq 2) 'Nonzero start should keep totalCount-initialStart products, not full totalCount.'
    Assert (($saved.sources[0].products | Where-Object { $_.id -eq '3' -and $_.available }).Count -eq 1) 'Offset product 3 missing.'
    Assert (($saved.sources[0].products | Where-Object { $_.id -eq '4' -and -not $_.available }).Count -eq 1) 'Offset product 4 missing.'
} finally {
    foreach ($path in @($configPath,$statePath,"$statePath.bak","$statePath.tmp","$statePath.lock",$fixturePath,
        "$prefix-search-config.json","$prefix-search-state.json","$prefix-search-state.json.bak","$prefix-search-state.json.tmp","$prefix-search-state.json.lock","$prefix-search-fixture.json",
        "$prefix-mismatch-config.json","$prefix-mismatch-state.json","$prefix-mismatch-state.json.lock","$prefix-mismatch-fixture.json",
        "$prefix-bound-config.json","$prefix-bound-state.json","$prefix-bound-state.json.lock","$prefix-bound-fixture.json",
        "$prefix-page-config.json","$prefix-page-state.json","$prefix-page-state.json.lock","$prefix-page-fixture.json",
        "$prefix-offset-config.json","$prefix-offset-state.json","$prefix-offset-state.json.bak","$prefix-offset-state.json.tmp","$prefix-offset-state.json.lock","$prefix-offset-fixture.json")) {
        if (Test-Path $path) { Remove-Item $path }
    }
}
Write-Host 'PASS: source URLs, strict availability, Continente matching/PDP/primary-OOS/class/disabled/unknown/conflicts, search canonical/dedup/pagination/empty/malformed/bounds/count-mismatch/nonzero-start, legacy migration, source isolation, silent baselines, preserved history.'
