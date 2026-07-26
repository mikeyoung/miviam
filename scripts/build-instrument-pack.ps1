#requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path $PSScriptRoot -Parent
$soundDir = Join-Path $root 'snd'
$packPath = Join-Path $soundDir 'instruments.pack'
$packTempPath = "$packPath.tmp"
$indexPath = Join-Path $root 'js\instrument-pack.js'
$indexTempPath = "$indexPath.tmp"

$instrumentNames = @(
	'Hofner Bass',
	'Cello',
	'Rhodes',
	'Vibes',
	'Celeste M400',
	'MKII-Flute',
	'Violins',
	'Choir'
)
$rootNames = @(
	'G1',
	'A_sharp_1',
	'C_sharp_2',
	'E2',
	'G2',
	'A_sharp_2',
	'C_sharp_3',
	'E3',
	'G3',
	'A_sharp_3',
	'C_sharp_4',
	'E4'
)

function Move-Atomic {
	param(
		[Parameter(Mandatory)][string]$TempPath,
		[Parameter(Mandatory)][string]$DestinationPath
	)

	if (Test-Path -LiteralPath $DestinationPath -PathType Leaf) {
		$backupPath = "$DestinationPath.previous"
		if (Test-Path -LiteralPath $backupPath) {
			Remove-Item -LiteralPath $backupPath -Force
		}
		[System.IO.File]::Replace($TempPath, $DestinationPath, $backupPath)
		Remove-Item -LiteralPath $backupPath -Force
	} else {
		[System.IO.File]::Move($TempPath, $DestinationPath)
	}
}

function Get-Sha256Hex {
	param([Parameter(Mandatory)][string]$Path)

	$algorithm = [System.Security.Cryptography.SHA256]::Create()
	$stream = $null
	try {
		$stream = [System.IO.File]::OpenRead($Path)
		$hash = $algorithm.ComputeHash($stream)
		return ([System.BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
	} finally {
		if ($null -ne $stream) { $stream.Dispose() }
		$algorithm.Dispose()
	}
}

$expectedNames = @(
	foreach ($instrumentName in $instrumentNames) {
		foreach ($rootName in $rootNames) {
			"$instrumentName $rootName.mp3"
		}
	}
)

$actualFiles = @(
	Get-ChildItem -LiteralPath $soundDir -File -Filter '*.mp3' |
		Where-Object { $_.Name -ne 'vinyl_noise.mp3' }
)
$actualNames = @($actualFiles | ForEach-Object { $_.Name })
$differences = @(Compare-Object -ReferenceObject $expectedNames -DifferenceObject $actualNames)
if ($differences.Count -ne 0) {
	$detail = $differences | ForEach-Object {
		if ($_.SideIndicator -eq '<=') { "missing: $($_.InputObject)" }
		else { "unexpected: $($_.InputObject)" }
	}
	throw "Instrument source set is not exactly 8 instruments x 12 notes:`n$($detail -join "`n")"
}

$orderedFiles = @($actualFiles | Sort-Object FullName)
$records = [System.Collections.Generic.List[object]]::new($orderedFiles.Count)
$packStream = $null
try {
	$packStream = [System.IO.File]::Open(
		$packTempPath,
		[System.IO.FileMode]::Create,
		[System.IO.FileAccess]::Write,
		[System.IO.FileShare]::None
	)
	$offset = [long]0
	foreach ($audioFile in $orderedFiles) {
		$length = [long]$audioFile.Length
		$records.Add([ordered]@{
			n = $audioFile.Name
			o = $offset
			l = $length
		})

		$inputStream = $null
		try {
			$inputStream = [System.IO.File]::OpenRead($audioFile.FullName)
			$inputStream.CopyTo($packStream, 131072)
		} finally {
			if ($null -ne $inputStream) { $inputStream.Dispose() }
		}
		$offset += $length
	}
} finally {
	if ($null -ne $packStream) { $packStream.Dispose() }
}

Move-Atomic -TempPath $packTempPath -DestinationPath $packPath

$packSize = [long](Get-Item -LiteralPath $packPath).Length
if ($packSize -ne $offset) {
	throw "Generated instrument pack size $packSize did not match indexed size $offset."
}

# Prove every indexed segment is byte-identical to its source file.
$packBytes = [System.IO.File]::ReadAllBytes($packPath)
for ($i = 0; $i -lt $orderedFiles.Count; $i += 1) {
	$sourceBytes = [System.IO.File]::ReadAllBytes($orderedFiles[$i].FullName)
	$record = $records[$i]
	if ($sourceBytes.Length -ne [int64]$record.l) {
		throw "Source length changed while building $($record.n)."
	}
	for ($j = 0; $j -lt $sourceBytes.Length; $j += 1) {
		if ($packBytes[[int64]$record.o + $j] -ne $sourceBytes[$j]) {
			throw "Pack byte mismatch in $($record.n) at source byte $j."
		}
	}
}

$packHash = Get-Sha256Hex -Path $packPath
$shortHash = $packHash.Substring(0, 12)
$manifestJson = ConvertTo-Json -InputObject $records -Compress
$indexSource = @"
(function () {
	"use strict";
	window.MIVIAM_INSTRUMENT_PACK = {
		url: "snd/instruments.pack?v=$shortHash",
		version: "$shortHash",
		sha256: "$packHash",
		size: $packSize,
		count: $($records.Count),
		files: $manifestJson
	};
})();
"@
[System.IO.File]::WriteAllText(
	$indexTempPath,
	$indexSource,
	[System.Text.UTF8Encoding]::new($false)
)
Move-Atomic -TempPath $indexTempPath -DestinationPath $indexPath

Write-Host "Built $packPath ($($records.Count) files, $packSize bytes, SHA-256 $packHash)"
Write-Host "Built $indexPath"
