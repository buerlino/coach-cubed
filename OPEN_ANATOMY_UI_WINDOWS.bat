@echo off
cd /d "%~dp0"
if exist .venv\Scripts\python.exe (
  .venv\Scripts\python.exe run_anatomy.py
) else (
  where py >nul 2>nul
  if errorlevel 1 (python run_anatomy.py) else (py -3 run_anatomy.py)
)
pause
