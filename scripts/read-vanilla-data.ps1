param([Parameter(Mandatory=$true)][string]$Jar)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskVanillaArchive = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $Jar))
try {
  $taskVanillaData = @{ recipes = @{}; blockLoot = @{}; itemTags = @{} }
  $taskVanillaVersionEntry = $taskVanillaArchive.GetEntry('version.json')
  if (-not $taskVanillaVersionEntry) { throw 'Not a vanilla server jar: version.json missing' }
  $taskVanillaVersionReader = [System.IO.StreamReader]::new($taskVanillaVersionEntry.Open())
  try { $taskVanillaData.version = $taskVanillaVersionReader.ReadToEnd() } finally { $taskVanillaVersionReader.Dispose() }
  foreach ($taskVanillaEntry in $taskVanillaArchive.Entries) {
    if ($taskVanillaEntry.FullName -match '^data/minecraft/(recipe|loot_table/blocks|tags/item)/(.+)\.json$') {
      $taskVanillaGroup = switch ($Matches[1]) { 'recipe' { 'recipes' } 'loot_table/blocks' { 'blockLoot' } 'tags/item' { 'itemTags' } }
      $taskVanillaName = $Matches[2]
      $taskVanillaReader = [System.IO.StreamReader]::new($taskVanillaEntry.Open())
      try { $taskVanillaData[$taskVanillaGroup][$taskVanillaName] = $taskVanillaReader.ReadToEnd() } finally { $taskVanillaReader.Dispose() }
    }
  }
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $taskVanillaData | ConvertTo-Json -Depth 100 -Compress
} finally { $taskVanillaArchive.Dispose() }
