@echo off
rem Build T3 display firmware with the PlatformIO that VS Code installed. Usage: tools\build_t3_firmware.bat [display numbers]
set PENV=%USERPROFILE%\.platformio\penv\Scripts
if not exist "%PENV%\python.exe" (echo PlatformIO not found: open the project once in VS Code with the PlatformIO extension & exit /b 1)
"%PENV%\python.exe" "%~dp0build_t3_firmware.py" %*
pause
