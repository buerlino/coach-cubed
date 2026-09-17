@echo off
rem Lives in launchers\; .venv lives at the repo root one level up, so this
rem must cd there before invoking anything relative.
cd /d "%~dp0.."
if exist .venv\Scripts\python.exe (
  .venv\Scripts\python.exe launchers\run_anatomy.py
) else (
  where py >nul 2>nul
  if errorlevel 1 (python launchers\run_anatomy.py) else (py -3 launchers\run_anatomy.py)
)
pause
