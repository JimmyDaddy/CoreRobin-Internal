param(
  [Parameter(Mandatory = $true)]
  [string]$BundleRoot
)

$ErrorActionPreference = "Stop"

function Assert-PeX64([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $reader = [System.IO.BinaryReader]::new($stream)
    if ($reader.ReadUInt16() -ne 0x5A4D) { throw "$Path is not a PE executable." }
    $stream.Position = 0x3C
    $peOffset = $reader.ReadUInt32()
    $stream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550) { throw "$Path has an invalid PE header." }
    if ($reader.ReadUInt16() -ne 0x8664) { throw "$Path is not an x64 executable." }
  } finally {
    $stream.Dispose()
  }
}

$msi = @(Get-ChildItem -Path (Join-Path $BundleRoot "msi") -Filter "*.msi" -File)
$nsis = @(Get-ChildItem -Path (Join-Path $BundleRoot "nsis") -Filter "*.exe" -File)
if ($msi.Count -ne 1 -or $nsis.Count -ne 1) {
  throw "Expected one MSI and one NSIS executable under $BundleRoot."
}

& 7z t $msi[0].FullName | Out-Null
if ($LASTEXITCODE -ne 0) { throw "7-Zip could not validate $($msi[0].Name)." }
& 7z t $nsis[0].FullName | Out-Null
if ($LASTEXITCODE -ne 0) { throw "7-Zip could not validate $($nsis[0].Name)." }

$extractRoot = Join-Path $env:RUNNER_TEMP ("corerobin-msi-" + [guid]::NewGuid())
New-Item -Path $extractRoot -ItemType Directory | Out-Null
try {
  $arguments = @("/a", ('"' + $msi[0].FullName + '"'), "/qn", ('TARGETDIR="' + $extractRoot + '"'))
  $process = Start-Process -FilePath "msiexec.exe" -ArgumentList $arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Administrative MSI extraction failed with exit code $($process.ExitCode)." }
  $application = @(Get-ChildItem -Path $extractRoot -Filter "core-robin.exe" -File -Recurse)
  if ($application.Count -ne 1) { throw "Expected one core-robin.exe in the extracted MSI." }
  Assert-PeX64 $application[0].FullName
} finally {
  Remove-Item -Path $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output "Verified Windows installers: $($msi[0].Name) and $($nsis[0].Name)."
