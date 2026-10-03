@echo off
title ApexWall AI - Sim Rig Telemetry Bridge
cls
echo ===================================================================
echo   APEXWALL AI // SIM RIG TELEMETRY BRIDGE
echo ===================================================================
echo.
echo   Supported sims (auto-detect):
echo     - iRacing                   : Shared Memory
echo     - Automobilista 2 / pCARS2  : UDP Port 5606
echo     - Forza Motorsport / Horizon: UDP Port 5300
echo     - F1 23 / 24 / 25           : UDP Port 20777
echo.
echo   Web dashboard: http://localhost:9001/api/status
echo.
echo   Keep this window open while driving.
echo   The ApexWall Telemetry tab will detect the bridge automatically.
echo ===================================================================
echo.

cd /d "%~dp0"
if not exist "ApexWall-Bridge.exe" (
  echo ERROR: ApexWall-Bridge.exe not found in %CD%
  echo Extract the full zip before running.
  pause
  exit /b 1
)
ApexWall-Bridge.exe %*
pause
