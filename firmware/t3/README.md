# T3 display firmware (pre-built)

The Pi burns these files into each ESP32-S3 from the first-run wizard (esptool, USB, no internet needed).
They are **not** built on the Pi.

```
firmware/t3/display1/{bootloader,partitions,boot_app0,firmware}.bin
firmware/t3/display2/...        (one folder per display, DISPLAY_ID is compiled in)
```

Build them once on a PC that has PlatformIO, then commit the folders:

```
python tools/build_t3_firmware.py        # all displays  (Windows: double-click tools\build_t3_firmware.bat)
python tools/build_t3_firmware.py 2      # only display 2
```

Rebuild and re-commit whenever `esp32_display_t3/` changes, and bump `FIRMWARE_VERSION` in `esp32_display_t3/platformio.ini`.
Check the build with `findstr /c:"t3-1.3.0" firmware\t3\display1\firmware.bin` (use the new version).

Once displays run, update them over the LAN from the web (lane card → อัปเดตเฟิร์มแวร์). Use `display<n>/firmware.bin`
for the display number shown in the confirm box (B<n>), not the lane number. The lane stays closed after the update
until you press เปิดเลน. Copy new files to the Pi with `tools\deploy_t3_to_pi.bat` so the USB wizard has them too.

Current build: `t3-1.3.0` (ARROW frame F32: ลูกศรตามทิศ 31 แบบจาก mask 1–31 · ภาพมาจาก `tools/arrow_design.py` · เวอร์ชันก่อนหน้า `t3-1.2.1` = F28–F31 และ F18 มี "!").
The wizard shows "ไม่มีไฟล์เฟิร์มแวร์" for a display whose folder is missing or incomplete.
Offsets, baud rate and esptool flags live in `config/settings*.json` -> `setup` (defaults in `t3/config.py`).
