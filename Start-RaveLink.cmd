@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-source.ps1"
if errorlevel 1 (
  echo.
  echo Setup failed. Read the message above, then try again.
  pause
  exit /b 1
)
