@echo off
rem Lives in launchers\; .venv and requirements-preview.txt belong at the repo
rem root one level up, so this must cd there before creating/using either.
cd /d "%~dp0.."
where py >nul 2>nul
if errorlevel 1 (python -m venv .venv) else (py -3 -m venv .venv)
if errorlevel 1 goto failed
.venv\Scripts\python.exe -m pip install -r requirements-preview.txt
if errorlevel 1 goto failed
echo Setup complete. Open launchers\start-local-windows.bat to launch.
pause
exit /b 0
:failed
echo Setup failed. Install Python 3.10 or newer, then try again.
pause
exit /b 1
