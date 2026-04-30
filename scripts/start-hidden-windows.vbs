Option Explicit

Dim shell, fso, scriptDir, repoDir, configPath, nodePath, serverPath, command

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
repoDir = fso.GetParentFolderName(scriptDir)
configPath = fso.BuildPath(repoDir, "config.json")
nodePath = "node"

If WScript.Arguments.Count >= 1 Then
  configPath = WScript.Arguments.Item(0)
End If

If WScript.Arguments.Count >= 2 Then
  nodePath = WScript.Arguments.Item(1)
End If

serverPath = fso.BuildPath(repoDir, "server.js")
shell.CurrentDirectory = repoDir

command = Quote(nodePath) & " " & Quote(serverPath) & " --config " & Quote(configPath)
shell.Run command, 0, False

Function Quote(value)
  Quote = """" & Replace(value, """", """""") & """"
End Function
