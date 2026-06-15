#requires -Version 5.1
<#
  Build the loadable MiViAm browser extension for Chrome + Firefox into
  extension/dist/<browser>/.

  Each bundle is a copy of the live web app (index.html, main.css,
  manifest.webmanifest, js/, img/, snd/) plus the per-browser manifest.json and
  the shared background.js opener. The PWA service worker is intentionally NOT
  copied: it is guarded off on the extension origin (see the location.protocol
  check at the end of js/main.js) and the assets are already packaged.

  dist/ is gitignored. Re-run this after any web-app change to refresh the bundle.

  Usage:  pwsh extension/build.ps1            # both browsers
          pwsh extension/build.ps1 -Target chrome
#>
[CmdletBinding()]
param(
	[ValidateSet('chrome', 'firefox', 'all')]
	[string]$Target = 'all'
)
$ErrorActionPreference = 'Stop'

$extDir = $PSScriptRoot
$root = Split-Path $extDir -Parent
$srcDir = Join-Path $extDir 'src'
$distDir = Join-Path $extDir 'dist'

# Web-app files + dirs that make up the bundle (NO service-worker.js).
$files = @('index.html', 'main.css', 'manifest.webmanifest')
$dirs = @('js', 'img', 'snd')

$targets = if ($Target -eq 'all') { @('chrome', 'firefox') } else { @($Target) }

foreach ($t in $targets) {
	$out = Join-Path $distDir $t
	if (Test-Path $out) { Remove-Item $out -Recurse -Force }
	New-Item -ItemType Directory -Path $out -Force | Out-Null

	foreach ($f in $files) {
		Copy-Item (Join-Path $root $f) (Join-Path $out $f) -Force
	}
	foreach ($d in $dirs) {
		Copy-Item (Join-Path $root $d) (Join-Path $out $d) -Recurse -Force
	}

	Copy-Item (Join-Path $srcDir 'background.js') (Join-Path $out 'background.js') -Force
	Copy-Item (Join-Path $srcDir "manifest.$t.json") (Join-Path $out 'manifest.json') -Force

	$items = Get-ChildItem $out -Recurse -File
	$mb = [math]::Round((($items | Measure-Object -Property Length -Sum).Sum) / 1MB, 2)
	Write-Host "Built $t -> $out  ($($items.Count) files, $mb MB)"
}
Write-Host 'Done. Load unpacked from extension/dist/<browser>/.'
