@echo off
cd /d "%~dp0"
if exist .venv\Scripts\python.exe (
  .venv\Scripts\python.exe run_original.py
) else (
  where py >nul 2>nul
  if errorlevel 1 (python run_original.py) else (py -3 run_original.py)
)
pause
