@echo off
rem ============================================================
rem  English Drill - hidden launcher body
rem
rem  Started by the desktop shortcut via the .vbs wrapper, which
rem  hides the console window.
rem
rem  Keep this file pure ASCII. cmd.exe reads .bat using the system
rem  ANSI codepage (GBK on this machine), so UTF-8 Chinese text
rem  would be mangled and break the commands.
rem
rem  IMPORTANT: never put a percent sign inside a rem line here.
rem  cmd expands percent sequences even in comments, so a stray
rem  "%~dp0" in a comment becomes garbage commands on stderr.
rem ============================================================
setlocal
cd /d "%~dp0"
node src\launcher.js
endlocal
