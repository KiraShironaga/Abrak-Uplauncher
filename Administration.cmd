@echo off
setlocal
cd /d "%~dp0"
set "ABRAK_NODE_CMD=node"
if defined ABRAK_NODE set "ABRAK_NODE_CMD=%ABRAK_NODE%"
if exist "%~dp0runtime\node\node.exe" set "ABRAK_NODE_CMD=%~dp0runtime\node\node.exe"
"%ABRAK_NODE_CMD%" tools\launch.mjs --admin
if errorlevel 1 pause
