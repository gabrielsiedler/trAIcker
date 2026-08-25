# Windows wrapper for Cursor Agent CLI (and Claude Code hooks loaded by it).
#
# Cursor on Windows does not pipe JSON into the hook over a real stdin. It
# writes a temp payload.json and runs:
#
#   Get-Content payload.json -Raw | & { $input | <command> }
#
# `$input | node script.js` delivers nothing to Node's fd 0 on Windows, so the
# bare hook sees an empty stdin, exits 0, and captures zero events. This
# wrapper reads the PowerShell pipeline correctly and forwards the JSON to
# the hook via --payload.
#
# Invoked as: powershell -NoProfile -File wrap-cursor-hook.ps1 <hook.js>
#
# IMPORTANT: do not use `param()` here. Cursor pipes the JSON into this
# process, and a param block would try to bind that JSON to -$HookJs and
# fail with InputObjectNotBound before we ever see $input.

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if ($args.Count -lt 1 -or [string]::IsNullOrWhiteSpace([string]$args[0])) {
  Write-Output "{}"
  exit 0
}
$HookJs = [string]$args[0]

# Collect everything Cursor (or Claude Code) fed into this process.
$chunks = New-Object System.Collections.Generic.List[string]
try {
  foreach ($line in $input) {
    [void]$chunks.Add([string]$line)
  }
} catch {
  # ignore enumerator errors
}

$json = ($chunks -join "`n")
if ([string]::IsNullOrWhiteSpace($json)) {
  try {
    $json = [Console]::In.ReadToEnd()
  } catch {
    $json = ""
  }
}

# Strip a UTF-8 BOM if the temp file carried one.
if (-not [string]::IsNullOrEmpty($json) -and [int][char]$json[0] -eq 0xFEFF) {
  $json = $json.Substring(1)
}

if ([string]::IsNullOrWhiteSpace($json)) {
  # Nothing to capture; still emit {} so Cursor does not classify empty_stdout.
  Write-Output "{}"
  exit 0
}

$payloadFile = Join-Path $env:TEMP ("traicker-hook-" + $PID + "-" + [guid]::NewGuid().ToString("n") + ".json")
try {
  [System.IO.File]::WriteAllText($payloadFile, $json)
  & node $HookJs --payload $payloadFile | Out-Null
} finally {
  Remove-Item -LiteralPath $payloadFile -Force -ErrorAction SilentlyContinue
}

# Cursor's CLI marks empty stdout as a failed hook even when exit code is 0.
Write-Output "{}"
exit 0
