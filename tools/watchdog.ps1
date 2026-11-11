# Run every 5 minutes by the task "Minima venues watchdog". If the dashboard does not answer within 15 s, it stops this
# project's own server process (and only that one: node.exe running Trading\tools\server.mjs) and starts it again.
# Each restart is written to data\watchdog.log.
$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $root 'data\watchdog.log'
try {
  $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 'http://127.0.0.1:8765/logo.svg'
  if ($r.StatusCode -eq 200) { exit 0 }
} catch { }
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*$root\tools\server.mjs*" }
foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep 3
Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + (Join-Path $root 'tools\start-hidden.vbs') + '"')
Add-Content -Path $log -Value ("{0} no answer from the dashboard: restarted (stopped {1} process(es))" -f (Get-Date -Format s), @($procs).Count)
