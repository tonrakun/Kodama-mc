@echo off
rem Starts a Kodama server with the recommended JVM flags. See start.ps1 for the options.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
