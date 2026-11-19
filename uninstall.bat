@echo off
rem uninstall.bat - double-click wrapper for uninstall.ps1 (dsh-editing-message).
rem Removes the bundle, the legacy installed copy and the referenced artifact.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
echo.
pause
