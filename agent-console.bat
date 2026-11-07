@echo off
rem agent-console: double-click to start the local server and open the console
rem in your default browser. If it is already running, this only opens a new
rem browser tab. ASCII-only on purpose (cmd codepage).
setlocal
cd /d "%~dp0"

where node >nul 2>nul || (echo [agent-console] Node.js 22.12+ is required. & pause & exit /b 1)

if not exist "node_modules\" (
  echo [setup] installing dependencies...
  call npm install --no-audit --no-fund || goto :fail
)
if not exist "dist\server\main.js" (
  echo [setup] building the engine...
  call npm run build || goto :fail
)
if not exist "ui\dist\index.html" (
  echo [setup] building the console UI...
  if not exist "ui\node_modules\" call npm --prefix ui install --no-audit --no-fund || goto :fail
  call npm --prefix ui run build || goto :fail
)

title agent-console
node dist\server\main.js %*
if errorlevel 1 goto :fail
exit /b 0

:fail
echo [agent-console] failed. See the messages above.
pause
exit /b 1
