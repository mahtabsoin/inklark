@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Inklark needs Node.js 24 or newer. Install it from https://nodejs.org
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 (
  echo Please update Node.js to version 24 or newer from https://nodejs.org
  pause
  exit /b 1
)
if not exist "node_modules\pdf-lib\package.json" (
  echo Setting up Inklark for the first time...
  call npm.cmd ci
  if errorlevel 1 goto failed
)
if not exist "dist\index.html" (
  call npm.cmd run build
  if errorlevel 1 goto failed
)
echo Opening Inklark. Keep this launcher running while using agent connections.
call npm.cmd start
if errorlevel 1 goto failed
exit /b 0
:failed
echo Inklark could not start. The error is shown above.
pause
exit /b 1
