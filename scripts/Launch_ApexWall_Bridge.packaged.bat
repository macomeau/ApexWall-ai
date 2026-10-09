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
echo     - ACC                      : Python sidecar (shared memory)
echo.
echo   Web dashboard: http://localhost:9001/api/status
echo.
echo   Voice PTT (optional): pip install pygame-ce sounddevice
echo     - Enables wheel-button push-to-talk for the race engineer.
echo     - Map buttons in the engineer chat: gear icon -^> BRIDGE PTT.
echo.
echo   Keep this window open while driving.
echo   The ApexWall Telemetry tab will detect the bridge automatically.
echo ===================================================================
echo.

cd /d "%~dp0"
if not exist "ApexWall-Bridge.exe" (
  echo ERROR: ApexWall-Bridge.exe was not found next to this launcher.
  echo Extract the whole ApexWall-Bridge.zip into one folder and try again.
  pause
  exit /b 1
)
ApexWall-Bridge.exe %*
pause
