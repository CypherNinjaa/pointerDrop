Set WshShell = CreateObject("WScript.Shell")
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
targetBat = CreateObject("Scripting.FileSystemObject").BuildPath(scriptDir, "..\start-turbo.bat")
WshShell.Run """" & targetBat & """", 0, False
