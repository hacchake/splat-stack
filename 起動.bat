@echo off
chcp 65001 > nul
cd /d %~dp0
if not exist node_modules (
  echo [Splat Stack] first run: installing packages...
  call npm install
)
echo [Splat Stack] starting... the browser will open automatically.
echo [Splat Stack] close this window to stop.
call npm run dev -- --open
pause
