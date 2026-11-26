@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20 or newer, then double-click this file again.
  echo Download: https://nodejs.org/
  pause
  exit /b 1
)

set "OPEN_DASHBOARD_BROWSER=1"
npm start
if errorlevel 1 (
  echo.
  echo The dashboard stopped because of an error. See the message above.
  pause
)
