' Starts the dashboard server with no window, its output in data\server.log. Used by the Windows logon task
' "Minima venues dashboard". If a server already runs on port 8765, this one stops at once (port in use): harmless.
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
If Not fso.FolderExists(root & "\data") Then fso.CreateFolder(root & "\data")
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = root
sh.Run "cmd /c node """ & root & "\tools\server.mjs"" >> """ & root & "\data\server.log"" 2>&1", 0, False
