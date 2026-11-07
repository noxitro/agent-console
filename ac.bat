@echo off
rem Launches the `ac` CLI (agent-console) without requiring `npm link`.
node "%~dp0dist\cli.js" %*
