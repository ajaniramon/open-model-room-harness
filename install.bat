@echo off
setlocal
cd /d "%~dp0"

title Open Model Room - Desktop Installer Bootstrap
echo.
echo  OPEN MODEL ROOM // INSTALL CONSOLE
echo  Preparing the desktop installer...
echo.

where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo [FAULT] Windows PowerShell is required to bootstrap Node.js.
  echo Install PowerShell or Node.js 20+, then run npm install and npm run setup.
  pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
set "INSTALL_EXIT=%ERRORLEVEL%"

if not "%INSTALL_EXIT%"=="0" (
  echo.
  echo [FAULT] Installation stopped with exit code %INSTALL_EXIT%.
  pause
)

exit /b %INSTALL_EXIT%
