' ============================================================
'  English Drill launcher (desktop shortcut target).
'
'  Runs launch-hidden.bat with the console hidden; that script starts
'  the local service, which then opens the practice window.
'
'  Keep this file pure ASCII: cscript reads .vbs with the system ANSI
'  codepage, so UTF-8 Chinese would break parsing. All Chinese
'  messages are printed by Node instead.
' ============================================================
Option Explicit

Dim fso, sh, root, batPath, okFile, waited

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

root    = fso.GetParentFolderName(WScript.ScriptFullName)
batPath = root & "\launch-hidden.bat"
okFile  = root & "\data\.launcher-ok"

If Not fso.FileExists(batPath) Then
  MsgBox "Cannot find launch-hidden.bat in:" & vbCrLf & root, 16, "English Drill"
  WScript.Quit 1
End If

' Clear the previous success marker so we can tell whether THIS start worked.
On Error Resume Next
fso.DeleteFile okFile, True
On Error GoTo 0

' 0 = hidden window, False = do not wait
sh.Run """" & batPath & """", 0, False

' Wait for the marker, up to about 60 seconds (first run can be slow).
waited = 0
Do While waited < 150
  WScript.Sleep 400
  waited = waited + 1
  If fso.FileExists(okFile) Then Exit Do
Loop

If Not fso.FileExists(okFile) Then
  MsgBox "English Drill failed to start." & vbCrLf & vbCrLf & _
         "The most common cause is Node.js missing (22.5 or newer required)." & vbCrLf & vbCrLf & _
         "To see the real error, open a command prompt and run:" & vbCrLf & vbCrLf & _
         "    cd /d """ & root & """" & vbCrLf & _
         "    node src\launcher.js", 16, "English Drill"
End If
