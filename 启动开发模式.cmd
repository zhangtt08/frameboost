@echo off
rem FrameBoost dev launcher
rem Requires Node.js >= 20.19 (recommended 22 LTS) on PATH
cd /d "%~dp0"
where node >nul 2>nul || (
  echo Node.js not found on PATH. Please install Node.js 22 LTS first.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
)
npm run dev
