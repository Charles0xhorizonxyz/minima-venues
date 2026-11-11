' Runs tools\watchdog.ps1 with no window. Started every 5 minutes by the task "Minima venues watchdog".
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & here & "\watchdog.ps1""", 0, False
