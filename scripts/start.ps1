# Starts a Kodama server with the recommended JVM flags.
#
#   .\start.ps1                       4G heap (G1), newest kodama-paperclip-*.jar in this directory
#   .\start.ps1 -Memory 10G -Gc zgc   generational ZGC, 10G heap
#
# Arguments after the named parameters are passed to the server.
[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$Memory = "4G",
    [ValidateSet("auto", "g1", "zgc")][string]$Gc = "auto",
    [string]$Java = $(if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME "bin\java.exe" } else { "java" }),
    [string]$Jar = "",
    [string]$ExtraJvmArgs = "",
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$ServerArgs = @()
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not $Jar) {
    $found = Get-ChildItem -Filter "kodama-paperclip-*.jar" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($found) { $Jar = $found.Name }
}
if (-not $Jar -or -not (Test-Path $Jar)) {
    Write-Error "No server jar found. Put kodama-paperclip-*.jar next to this script or pass -Jar."
}

# java -version writes to stderr, which Windows PowerShell turns into an error under "Stop"
$versionLine = (& { $ErrorActionPreference = "Continue"; & $Java -version 2>&1 } | Select-Object -First 1).ToString()
if ($versionLine -notmatch 'version "(\d+)') { Write-Error "Could not read the Java version: $versionLine" }
$javaMajor = [int]$Matches[1]
if ($javaMajor -lt 21) { Write-Error "Java 21 or newer is required, found: $versionLine" }

$heapGb = if ($Memory -match '^(\d+)[Mm]$') { [int]$Matches[1] / 1024 } elseif ($Memory -match '^(\d+)') { [int]$Matches[1] } else { 0 }

$flags = @("-Xms$Memory", "-Xmx$Memory", "-XX:+AlwaysPreTouch", "-XX:+DisableExplicitGC", "-XX:+PerfDisableSharedMem")

# zgc had fewer slow ticks in the Kodama benchmark but needs about 20% more heap
if ($Gc -eq "auto") { $Gc = if ($heapGb -ge 6) { "zgc" } else { "g1" } }

if ($Gc -eq "g1") {
    # Aikar's flags; the young generation and regions grow with the heap above 12G
    if ($heapGb -gt 12) {
        $young = @("-XX:G1NewSizePercent=40", "-XX:G1MaxNewSizePercent=50", "-XX:G1HeapRegionSize=16M", "-XX:G1ReservePercent=15", "-XX:InitiatingHeapOccupancyPercent=20")
    } else {
        $young = @("-XX:G1NewSizePercent=30", "-XX:G1MaxNewSizePercent=40", "-XX:G1HeapRegionSize=8M", "-XX:G1ReservePercent=20", "-XX:InitiatingHeapOccupancyPercent=15")
    }
    $flags += @("-XX:+UseG1GC", "-XX:+ParallelRefProcEnabled", "-XX:MaxGCPauseMillis=200", "-XX:+UnlockExperimentalVMOptions") + $young + @(
        "-XX:G1HeapWastePercent=5", "-XX:G1MixedGCCountTarget=4", "-XX:G1MixedGCLiveThresholdPercent=90",
        "-XX:G1RSetUpdatingPauseTimePercent=5", "-XX:SurvivorRatio=32", "-XX:MaxTenuringThreshold=1")
} else {
    $flags += "-XX:+UseZGC"
    # generational is the only mode from JDK 23; before that it has to be asked for
    if ($javaMajor -lt 23) { $flags += "-XX:+ZGenerational" }
}

if ($javaMajor -ge 25) {
    $flags += "-XX:+UseCompactObjectHeaders"
} elseif ($javaMajor -eq 24) {
    $flags += @("-XX:+UnlockExperimentalVMOptions", "-XX:+UseCompactObjectHeaders")
}

$extra = @($ExtraJvmArgs -split '\s+' | Where-Object { $_ })
& $Java @flags @extra -jar $Jar --nogui @ServerArgs
exit $LASTEXITCODE
