@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title Voyager - Local Game Server
cd /d "%~dp0"

where node.exe >nul 2>&1
if errorlevel 1 (
  echo Please install Node.js 24 LTS, then double-click this file again.
  pause
  exit /b 1
)

if not exist "node_modules\vite\bin\vite.js" (
  echo Installing project dependencies...
  call npm.cmd ci --no-audit --no-fund
  if errorlevel 1 (
    echo Dependency installation failed. Check the error above.
    pause
    exit /b 1
  )
)

node "scripts\launch-local.mjs" %*
if errorlevel 1 (
  echo Startup failed. Check the error above.
  pause
  exit /b 1
)
