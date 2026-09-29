@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PORT=8765
where py >nul 2>nul && (set PY=py) || (where python >nul 2>nul && (set PY=python) || (set PY=))
if "%PY%"=="" (
  echo ไม่พบ Python จึงเปิดไฟล์ตรงๆ แทน
  start "" "%~dp0t3-simulator.html"
  exit /b
)
echo กำลังเปิด T3 Simulator ที่ http://localhost:%PORT%/t3-simulator.html
echo ปิดหน้าต่างนี้เมื่อเลิกใช้งาน
start "" "http://localhost:%PORT%/t3-simulator.html"
%PY% -m http.server %PORT% --bind 127.0.0.1
