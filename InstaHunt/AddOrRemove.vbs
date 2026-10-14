Option Explicit
Dim shell, files, folder, script, powershell, command
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
folder = files.GetParentFolderName(WScript.ScriptFullName)
script = files.BuildPath(folder, "AddOrRemove.ps1")
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
If Not files.FileExists(script) Then
    MsgBox "AddOrRemove.ps1 is missing. Extract the complete InstaHunt folder and try again.", 16, "Insta Hunt"
    WScript.Quit 1
End If
command = Chr(34) & powershell & Chr(34) & " -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & script & Chr(34)
On Error Resume Next
shell.Run command, 0, False
If Err.Number <> 0 Then
    MsgBox "Could not open AddOrRemove: " & Err.Description, 16, "Insta Hunt"
    WScript.Quit 1
End If
