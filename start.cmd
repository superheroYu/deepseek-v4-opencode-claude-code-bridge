@echo off
setlocal
cd /d "%~dp0"
node server.js --config "%~dp0config.json" %*
