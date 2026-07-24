#requires -Version 5.1
<#
  Build the loadable MiViAm browser extension for Chrome + Firefox into
  extension/dist/<browser>/ and package store-ready versioned zip archives.

  Each bundle is a copy of the live web app (index.html, main.css,
  manifest.webmanifest, js/, img/, snd/) plus the per-browser manifest.json and
  the shared background.js opener. The PWA service worker is intentionally NOT
  copied: it is guarded off on the extension origin (see the location.protocol
  check at the end of js/main.js) and the assets are already packaged.

  dist/ is gitignored. Re-run this after any web-app change to refresh the bundle
  and miviam-<browser>-<version>.zip. After a new archive is successfully built
  and validated, older zip versions for that browser are removed.

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
Add-Type -AssemblyName System.IO.Compression.FileSystem

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

	# Web-app img/ assets that are NOT part of the extension package (e.g. a
	# store-listing-only icon kept in the repo). Dropped after the wholesale copy.
	$bundleExclude = @('img\icon-128.png')
	foreach ($x in $bundleExclude) {
		$p = Join-Path $out $x
		if (Test-Path $p) { Remove-Item $p -Force }
	}

	Copy-Item (Join-Path $srcDir 'background.js') (Join-Path $out 'background.js') -Force
	Copy-Item (Join-Path $srcDir "manifest.$t.json") (Join-Path $out 'manifest.json') -Force

	$items = Get-ChildItem $out -Recurse -File
	$mb = [math]::Round((($items | Measure-Object -Property Length -Sum).Sum) / 1MB, 2)
	Write-Host "Built $t -> $out  ($($items.Count) files, $mb MB)"

	$manifest = Get-Content (Join-Path $out 'manifest.json') -Raw | ConvertFrom-Json
	$version = [string]$manifest.version
	if ([string]::IsNullOrWhiteSpace($version)) {
		throw "Cannot package ${t}: manifest.json has no version."
	}

	$zipName = "miviam-$t-$version.zip"
	$zipPath = Join-Path $distDir $zipName
	$tempZipPath = Join-Path $distDir "miviam-$t-$version.tmp.zip"
	if (Test-Path $tempZipPath) { Remove-Item $tempZipPath -Force }

	# Compress the bundle CONTENTS so manifest.json sits at the archive root.
	$topLevelItems = Get-ChildItem $out -Force
	Compress-Archive -Path $topLevelItems.FullName -DestinationPath $tempZipPath `
		-CompressionLevel Optimal -Force

	# Validate before replacing the current archive or deleting older versions.
	$zip = [System.IO.Compression.ZipFile]::OpenRead($tempZipPath)
	try {
		$entryNames = @($zip.Entries | ForEach-Object { $_.FullName })
		if (-not ($entryNames -contains 'manifest.json')) {
			throw "Cannot package ${t}: manifest.json is not at the archive root."
		}
		if ($entryNames -contains 'service-worker.js') {
			throw "Cannot package ${t}: service-worker.js must be excluded."
		}
		if ($entryNames -contains 'img/icon-128.png') {
			throw "Cannot package ${t}: store-listing icon must be excluded."
		}
		$entryCount = $zip.Entries.Count
	} finally {
		$zip.Dispose()
	}

	Move-Item $tempZipPath $zipPath -Force

	# Keep only the successfully generated version for this browser.
	Get-ChildItem $distDir -File -Filter "miviam-$t-*.zip" |
		Where-Object { $_.FullName -ne $zipPath } |
		ForEach-Object { Remove-Item $_.FullName -Force }

	$zipMb = [math]::Round((Get-Item $zipPath).Length / 1MB, 2)
	Write-Host "Packaged $t -> $zipPath  ($entryCount entries, $zipMb MB)"
}
Write-Host 'Done. Load unpacked from extension/dist/<browser>/ or upload the versioned zip.'
