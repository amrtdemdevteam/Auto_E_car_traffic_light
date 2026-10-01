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

Rebuild and re-commit whenever `esp32_display_t3/` changes (or use OTA from the web once displays run).
The wizard shows "ไม่มีไฟล์เฟิร์มแวร์" for a display whose folder is missing or incomplete.
Offsets, baud rate and esptool flags live in `config/settings*.json` -> `setup` (defaults in `t3/config.py`).
