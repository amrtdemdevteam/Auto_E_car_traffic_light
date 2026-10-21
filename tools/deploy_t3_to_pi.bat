@echo off
rem Copy the T3 controller + web files (and the pre-built display firmware) from this PC to the Pi,
rem then restart the services. Run from anywhere: tools\deploy_t3_to_pi.bat
rem 2026-10-21: copies every web/static file and every t3/*.py (vehicles.js, draw.js, timing.js, sensors.py were missing).
rem Asks for the Pi IP and ssh user; you type the passwords yourself (scp, ssh, sudo).
setlocal
cd /d "%~dp0\.."
set PI=10.77.0.1
set /p PI=Pi IP [10.77.0.1, or 192.168.50.99 on the office LAN]: 
set APP=/opt/trafficlight/raspberry_pi/trafficlight
set FW=/opt/trafficlight/firmware/t3
set /p PI_USER=Pi ssh user [trafficlight]: 
if "%PI_USER%"=="" set PI_USER=trafficlight

echo.
echo [1/3] copy code to %PI_USER%@%PI%:/tmp/t3up/
ssh %PI_USER%@%PI% "rm -rf /tmp/t3up && mkdir -p /tmp/t3up/fw" || goto fail
scp raspberry_pi\trafficlight\web\static\app.css raspberry_pi\trafficlight\web\static\app.js raspberry_pi\trafficlight\web\static\diag.js raspberry_pi\trafficlight\web\static\draw.js raspberry_pi\trafficlight\web\static\index.html raspberry_pi\trafficlight\web\static\led.js raspberry_pi\trafficlight\web\static\logo.jpg raspberry_pi\trafficlight\web\static\logo.png raspberry_pi\trafficlight\web\static\osk.js raspberry_pi\trafficlight\web\static\rotate.js raspberry_pi\trafficlight\web\static\sim.js raspberry_pi\trafficlight\web\static\timing.js raspberry_pi\trafficlight\web\static\vehicles.js raspberry_pi\trafficlight\web\static\wizard.js raspberry_pi\trafficlight\t3\__init__.py raspberry_pi\trafficlight\t3\config.py raspberry_pi\trafficlight\t3\controller.py raspberry_pi\trafficlight\t3\display_link.py raspberry_pi\trafficlight\t3\flowstats.py raspberry_pi\trafficlight\t3\frames.py raspberry_pi\trafficlight\t3\ports.py raspberry_pi\trafficlight\t3\queue.py raspberry_pi\trafficlight\t3\runner.py raspberry_pi\trafficlight\t3\sensors.py %PI_USER%@%PI%:/tmp/t3up/ || goto fail

echo.
echo [2/3] copy display firmware (used by the USB flasher in the setup wizard)
scp -r firmware\t3\display1 firmware\t3\display2 firmware\t3\display3 firmware\t3\display4 firmware\t3\display5 %PI_USER%@%PI%:/tmp/t3up/fw/ || goto fail

echo.
echo [3/3] install + restart (sudo password on the Pi)
ssh -t %PI_USER%@%PI% "cd /tmp/t3up && sudo cp app.css app.js diag.js draw.js index.html led.js logo.jpg logo.png osk.js rotate.js sim.js timing.js vehicles.js wizard.js %APP%/web/static/ && sudo cp __init__.py config.py controller.py display_link.py flowstats.py frames.py ports.py queue.py runner.py sensors.py %APP%/t3/ && sudo mkdir -p %FW% && sudo cp -r fw/display1 fw/display2 fw/display3 fw/display4 fw/display5 %FW%/ && sudo systemctl restart trafficlight trafficlight-web && sleep 2 && systemctl is-active trafficlight trafficlight-web && grep -c STOP_QUEUED %APP%/t3/frames.py %APP%/t3/controller.py" || goto fail

echo.
echo DONE. Both services must say "active" and the last number must be 1 or more.
echo Refresh the page on the Pi screen (Ctrl+F5 on a PC browser).
echo OTA: in the web, lane card - firmware update button - pick firmware\t3\displayN\firmware.bin of THAT display.
pause
exit /b 0

:fail
echo.
echo FAILED - check the network / Pi IP / ssh user, then run again.
pause
exit /b 1
