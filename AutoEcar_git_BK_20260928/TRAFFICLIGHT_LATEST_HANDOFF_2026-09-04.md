# E-Car Traffic Light System — Historical Handoff / Copilot Context
**Date:** 2026-09-04  
**Current working branch:** `trafficlight`  
**Purpose:** Historical field-debug context. Current production handoff is `TRAFFICLIGHT_V1_FIELD_HANDOFF_2026-09-05.md`.  
**Important:** Preserve all confirmed working behavior. Do not reintroduce old assumptions.

> Historical note: this file contains earlier S1->S2 / S3->S4 logic and tuning notes from before the final Friday baseline. Do not use those sections as current production behavior.

---

# 1. Project Goal

Build an industrial traffic-light system for Auto E-Car / dolly traffic in a factory.

The system uses:

- Raspberry Pi 4 as the main controller
- 4 × TF-Mini Plus sensors
- RS485 transport from sensors to Pi
- ESP32-S3 + W5500 Ethernet display controllers
- HUB75 P5 64×32 LED matrix panels
- MQTT communication over isolated Ethernet
- Mosquitto broker on Raspberry Pi

The first field-test strategy is intentionally:

1. Make **1 Display + 1 Sensor** work completely.
2. Then add LAN switch.
3. Then add ESP Display 2/3.
4. Then add all 4 sensors.
5. Then test full direction/state logic.

Do not debug all hardware simultaneously.

---

# 2. System Architecture

```text
TF-Mini Plus S1..S4
        │
        │ UART TTL
        ▼
TTL ↔ RS485 converter
        │
        │ RS485 A/B
        ▼
Waveshare Industrial USB-RS485
        │
        │ USB
        ▼
Raspberry Pi 4
10.77.0.1/24
        │
        │ Traffic logic
        │ MQTT publish
        ▼
Mosquitto Broker
10.77.0.1:1883
        │
        │ Ethernet
        ▼
LAN Switch
 ├── ESP Display1 10.77.0.11
 ├── ESP Display2 10.77.0.12
 ├── ESP Display3 10.77.0.13
 ├── ...
 └── ESP Display7 10.77.0.17
        │
        │ W5500 SPI
        ▼
ESP32-S3 ESP-HUB75
        │
        │ HUB75
        ▼
P5 64×32 Matrix Panel
```

Wi-Fi is for maintenance / Git / SSH / VNC only.

Display traffic network uses isolated `eth0`.

---

# 3. Raspberry Pi Network

Confirmed working:

```text
eth0 = 10.77.0.1/24
wlan0 = hotspot / maintenance network
```

When LAN is physically connected:

```text
eth0 UP
carrier = 1
```

Mosquitto confirmed working:

```text
10.77.0.1:1883
```

Commands:

```bash
ip -br addr
cat /sys/class/net/eth0/carrier
systemctl is-active mosquitto
sudo ss -lntp | grep 1883
```

Expected:

```text
eth0 UP 10.77.0.1/24
carrier=1
mosquitto=active
LISTEN 10.77.0.1:1883
```

---

# 4. MQTT Design

Main command topic:

```text
factory/trafficlight/junction/1/display
```

Every display subscribes to the same command topic.

Status topics:

```text
factory/trafficlight/junction/1/display/1/status
factory/trafficlight/junction/1/display/2/status
...
factory/trafficlight/junction/1/display/7/status
```

Broker:

```text
10.77.0.1
port 1883
```

Display status payload:

```text
online
offline
```

The Pi decides the traffic state.

ESP displays only receive commands and render them.

---

# 5. Traffic Display Behavior

Required final behavior:

## GREEN
- Full green background
- No normal-state text

## YELLOW / RETURN
- Full yellow background
- `CAUTION`
- High contrast black text

## RED
- Full red background
- `STOP`
- High contrast white text

## Sensor Fault
- Small fault overlay only
- Must NOT replace the main traffic indication
- Example: `ERR:S2`

All displays at one junction show the same state simultaneously.

---

# 6. Traffic State Logic

Normal junction V1:

```text
IDLE = GREEN

S1 → S2
    => YELLOW

S3 → S4
    => RED immediately

RED
    => fixed 3 sec

then
RETURN YELLOW
    => 5 sec

after RETURN:
    if vehicle occupancy still exists
        => YELLOW
    else
        => GREEN
```

Reverse directions:

```text
S2 → S1 = ignore
S4 → S3 = ignore
```

Do not allow reverse events to later form a false forward sequence.

---

# 7. Vehicle / Dolly Detection Logic

Auto E-Car may tow multiple dollies.

Raw sensor waveform can contain multiple gaps:

```text
vehicle head
→ operator/body gap
→ vehicle rear
→ towing gap
→ dolly
→ gap
→ dolly
...
```

Therefore raw sensor ON/OFF must NOT directly represent one vehicle.

Layered logic:

1. raw TF-Mini distance
2. debounce
3. gap-hold / occupancy
4. sequence timestamps
5. direction detection
6. traffic state machine

Important configurable values:

```text
distance threshold ≈ <270 cm
debounce ≈ 200 ms
gap_hold_s ≈ 1.2–1.5 sec starting point
new_vehicle_gap_s ≈ 2.5–3 sec possible starting point
pair_window_s ≈ 2 sec starting point
sensor offline timeout ≈ 2 sec
```

These are field-tuning parameters, not architecture changes.

---

# 8. TF-Mini Plus

Expected UART:

```text
115200 baud
```

Frame:

```text
0x59 0x59 ...
```

Distance:

```text
distance_cm = distL + distH * 256
```

Strength filtering originally targeted approximately:

```text
strength >= 100
```

Do not over-tune until real field waveform is observed.

---

# 9. USB-RS485 Hardware

Actual USB-RS485 converter:

```text
Waveshare Industrial USB to RS485 Bidirectional Converter
SKU / MPN: 17286
Chipset: FT232RNL + SP485EEN
```

Production code must NOT rely on:

```text
/dev/ttyUSB0
/dev/ttyUSB1
/dev/ttyUSB2
/dev/ttyUSB3
```

Persistent names:

```text
/dev/traffic-S1
/dev/traffic-S2
/dev/traffic-S3
/dev/traffic-S4
```

Preferred udev strategy:

1. unique `ID_SERIAL_SHORT` if available
2. fallback to `ID_PATH` if serial is absent/duplicated

If path-based mapping is used, adapters must remain in their assigned physical USB ports.

Mapping script:

```bash
sudo bash scripts/generate_udev_rules.sh
```

Verification:

```bash
ls -l /dev/traffic-S*
```

---

# 10. ESP-HUB75 Board

Board:

```text
ESP-HUB75
ESP32-S3
ArtronShop board
```

Actual flash confirmed by hardware:

```text
4 MB Flash
2 MB PSRAM reported by ESP
```

The original PlatformIO board profile described an 8 MB board, so the project MUST override flash size.

Required `platformio.ini` values:

```ini
board_upload.flash_size = 4MB
board_upload.maximum_size = 4194304
board_build.partitions = default.csv
```

USB serial debug also requires:

```ini
-DARDUINO_USB_MODE=1
-DARDUINO_USB_CDC_ON_BOOT=1
```

---

# 11. ESP PlatformIO Dependencies

Confirmed cached and building successfully on the Windows notebook:

```text
espressif32 @ 7.1.0
framework-arduinoespressif32 @ 3.20017.241212+sha.dcc1105b
tool-esptoolpy @ 4.11.0
toolchain-xtensa-esp32s3 @ 8.4.0+2021r2-patch5
toolchain-riscv32-esp @ 8.4.0+2021r2-patch5

ESP32 HUB75 LED MATRIX PANEL DMA Display @ 3.0.15
Adafruit GFX Library @ 1.12.6
Adafruit BusIO @ 1.17.4
PubSubClient @ 2.8.0
Ethernet @ 2.0.2
ArduinoJson @ 7.4.3
SPI @ 2.0.0
```

`intelhex` is installed in PlatformIO Python environment.

Exact PlatformIO executable:

```text
C:\Users\SmartFactory\.platformio\penv\Scripts\platformio.exe
```

All environments were built successfully:

```text
display1 PASS
display2 PASS
display3 PASS
display4 PASS
display5 PASS
display6 PASS
display7 PASS
```

No large PlatformIO downloads should be needed for normal build/flash tomorrow.

---

# 12. IMPORTANT — Correct W5500 SPI Mapping

This was a major real field bug.

Do NOT use the previous incorrect mapping.

The real ESP-HUB75 schematic confirms:

```text
W5500 CS   = GPIO21
W5500 MOSI = GPIO13
W5500 SCK  = GPIO12
W5500 MISO = GPIO11
```

The project must use:

```cpp
#define W5500_CS   21
#define W5500_MOSI 13
#define W5500_SCK  12
#define W5500_MISO 11
```

An additional reset wire was manually added:

```text
W5500 RST → ESP GPIO4
```

and currently:

```cpp
#define W5500_RST 4
```

Reset sequence:

```cpp
pinMode(W5500_RST, OUTPUT);

digitalWrite(W5500_RST, LOW);
delay(10);

digitalWrite(W5500_RST, HIGH);
delay(200);
```

Then:

```cpp
SPI.begin(
    W5500_SCK,
    W5500_MISO,
    W5500_MOSI,
    W5500_CS
);

Ethernet.init(W5500_CS);
Ethernet.begin(...);
```

This corrected SPI mapping changed the real ESP Serial status from:

```text
ETH=NO_HARDWARE
LINK=UNKNOWN
IP=255.255.255.255
MQTT=OFF
```

to:

```text
ETH=W5500
LINK=ON
IP=10.77.0.11
MQTT=ON
```

Therefore this mapping is confirmed working on real hardware.

Do NOT revert it.

---

# 13. HUB75 Mapping

Current working HUB75 mapping:

```cpp
// R1,G1,B1,R2,G2,B2,A,B,C,D,E,LAT,OE,CLK
HUB75_I2S_CFG::i2s_pins hub75Pins = {
    42, 41, 40, 39, 38, 37,
    48, 36, 45, 35, -1,
    47, 14, 2
};
```

Confirmed by real hardware:

- full green works
- full yellow works
- full red works

Do not change this mapping without strong evidence.

---

# 14. Important Physical HUB75 Discovery

The P5 panel has `IN` and `OUT`.

The first test accidentally connected the ESP ribbon to the panel `OUT`.

Result:

```text
panel remained black
```

After moving ribbon to the panel `IN`:

```text
panel immediately worked
```

Therefore:

```text
ESP-HUB75 ribbon MUST connect to P5 INPUT / IN
```

Do not troubleshoot software before verifying this.

---

# 15. Display1 Confirmed Working Chain

Real hardware confirmation:

```text
Raspberry Pi eth0        PASS
10.77.0.1/24             PASS
Mosquitto                PASS
W5500 detection          PASS
Ethernet link            PASS
Display1 IP 10.77.0.11   PASS
MQTT connect             PASS
MQTT RX                  PASS
HUB75 physical output    PASS
P5 power 5V              PASS
P5 color fill            PASS
```

The Serial heartbeat showed:

```text
ETH=W5500
LINK=ON
IP=10.77.0.11
MQTT=ON
```

This is the known-good network condition.

---

# 16. Current Display Text Problem

Color fills are proven correct:

```text
GREEN full-screen  PASS
YELLOW full-screen PASS
RED full-screen    PASS
```

However the normal Adafruit GFX text rendering through:

```cpp
matrix->setTextSize(...)
matrix->setTextColor(...)
matrix->setCursor(...)
matrix->print(...)
```

did NOT render correctly on the real panel.

Observed behavior:

- yellow sometimes had no readable text
- red text appeared malformed / round / unreadable
- previous attempts appeared visually corrupted
- fillScreen-only test was completely clean

Therefore the current preferred solution is:

```text
DO NOT rely on matrix->print() for traffic text.
Use a custom 5×7 bitmap drawn directly with matrix->fillRect().
```

This uses the same basic pixel drawing primitives already proven to work on the panel.

---

# 17. Latest Proposed Text Renderer

The latest `main.cpp` replacement uses:

```text
custom 5×7 glyphs
drawGlyph5x7()
drawText5x7()
drawCenteredText5x7()
```

Traffic rendering:

```text
GREEN:
full green
no text

YELLOW:
full yellow
CAUTION in black
custom bitmap

RED:
full red
STOP in white
custom bitmap scale 2
```

Fault overlay also uses the custom bitmap renderer rather than Adafruit `print()`.

This replacement should be reviewed/build-tested/field-tested before being considered final.

Important distinction:

```text
Confirmed:
full-screen color fill works.

Not yet confirmed at the time of this handoff:
custom bitmap CAUTION / STOP rendering on the real panel.
```

---

# 18. ESP Debug Logging

Serial monitor is intentionally verbose for field bring-up.

Baud:

```text
115200
```

Expected boot structure:

```text
================================================
 E-CAR TRAFFIC LIGHT DISPLAY
 Firmware : 1.0.4-debug
 Display  : 1
================================================

BOOT
CONFIG
HUB75
SPI
ETH
MQTT
HEART
```

Useful heartbeat:

```text
HEART | ETH=W5500 LINK=ON IP=10.77.0.11 MQTT=ON STATE=...
```

Debug logs should remain controlled:
- do not print every loop
- heartbeat about every 5 seconds
- state/log transitions only when meaningful

---

# 19. Windows Flash Commands

Check COM:

```cmd
C:\Users\SmartFactory\.platformio\penv\Scripts\platformio.exe device list
```

Display1 build:

```cmd
cd C:\TPCAP_TRAFFIC_LIGHT\AutoEcar_git\esp32_display

C:\Users\SmartFactory\.platformio\penv\Scripts\platformio.exe run -e display1
```

Flash Display1:

```cmd
C:\Users\SmartFactory\.platformio\penv\Scripts\platformio.exe run -e display1 -t upload --upload-port COM10
```

Serial monitor:

```cmd
C:\Users\SmartFactory\.platformio\penv\Scripts\platformio.exe device monitor --port COM10 --baud 115200
```

COM number may change.

Always run `device list` if unsure.

---

# 20. Display ID / Static IP Mapping

```text
display1 → DISPLAY_ID=1 → 10.77.0.11
display2 → DISPLAY_ID=2 → 10.77.0.12
display3 → DISPLAY_ID=3 → 10.77.0.13
display4 → DISPLAY_ID=4 → 10.77.0.14
display5 → DISPLAY_ID=5 → 10.77.0.15
display6 → DISPLAY_ID=6 → 10.77.0.16
display7 → DISPLAY_ID=7 → 10.77.0.17
```

Do NOT flash all physical ESPs as `display1`.

Each display must use its corresponding PlatformIO environment.

---

# 21. Current Raspberry Pi Git State

The Pi successfully pulled the debug revision:

```text
VERSION = 1.0.4-debug
```

Observed commit:

```text
a1928f9 feat: update install and debug scripts
```

Before that, Pi had local edits in:

```text
install.sh
scripts/friday_preflight.sh
scripts/generate_udev_rules.sh
```

Those were safely stashed before pull:

```bash
git stash push -m "pi-local-before-v1.0.4-debug"
```

Do NOT blindly `git stash pop` unless specifically reviewing old local changes.

Remote latest should remain source of truth.

---

# 22. Pi Debug Scripts

Available:

```text
scripts/friday_preflight.sh
scripts/display_network_debug.sh
scripts/system_debug.sh
scripts/generate_udev_rules.sh
scripts/display_test.sh
```

Run via `bash` to avoid executable-bit issues:

```bash
bash scripts/friday_preflight.sh
bash scripts/display_network_debug.sh
bash scripts/system_debug.sh
```

---

# 23. Display Test

Pi command:

```bash
cd ~/trafficlight
bash scripts/display_test.sh
```

Expected state sequence:

```text
GO
CAUTION
STOP
Fault overlay
Return GO
```

The real system successfully received MQTT transitions at Display1.

Serial logs confirmed MQTT RX and display state changes.

---

# 24. Raspberry Pi Python Runtime

Runtime dependencies:

```text
pyserial>=3.5,<4
paho-mqtt>=2.1,<3
loguru>=0.7,<1
```

Tests use pytest.

Runtime venv:

```text
/opt/trafficlight/.venv
```

Previous real issue:
- system Python had pytest but venv did not
- runtime had loguru only inside venv

Current installer was updated so pytest should be installed into the venv too.

Previous validated test command:

```bash
PYTHONPATH=raspberry_pi \
/opt/trafficlight/.venv/bin/python -m pytest -q tests
```

Known result:

```text
11 passed
```

---

# 25. Known Mosquitto Issues Already Fixed

Do not reintroduce these bugs.

## Old bug 1
Duplicate:

```text
persistence_location
```

caused Mosquitto config failure.

Current trafficlight-specific config should remain minimal.

## Old bug 2
Hostname changed to `trafficlight` but `/etc/hosts` was not updated.

This caused:

```text
sudo: unable to resolve host trafficlight
```

Installer was fixed.

## Old bug 3
Mosquitto booted before `eth0` had `10.77.0.1`.

Broker failed because it binds only to:

```text
10.77.0.1:1883
```

A systemd drop-in was added to wait for:

```text
eth0 10.77.0.1/24
```

before Mosquitto starts.

Keep isolated binding.
Do NOT change to `0.0.0.0` casually.

---

# 26. Current Test Strategy

Current priority:

```text
1 Display + 1 Sensor
```

Do NOT start with:
- 3 displays
- LAN switch
- 4 sensors
- full traffic logic

First prove:

```text
Pi → W5500 → ESP1 → P5
```

and:

```text
TF-Mini → RS485 → Pi
```

completely.

Then scale.

---

# 27. Next Immediate Task

The immediate unfinished task is:

```text
Make CAUTION and STOP render correctly on the real P5 panel.
```

Current recommended implementation:
custom bitmap 5×7 font drawn with `fillRect()`.

Copilot should:

1. inspect current `esp32_display/src/main.cpp`
2. preserve all working network/W5500 debug logic
3. preserve confirmed W5500 pins
4. preserve HUB75 pins
5. avoid `matrix->print()` for traffic text
6. implement or review custom bitmap rendering
7. build `display1`
8. do NOT claim real display success until field-tested
9. keep GREEN without normal text
10. keep fault overlay small and non-blocking

---

# 28. After Text Works

Then begin Sensor1 test.

Basic detection:

```bash
ls -l /dev/ttyUSB* /dev/ttyACM* 2>/dev/null
```

Example identity:

```bash
udevadm info --query=property --name=/dev/ttyUSB0 | \
grep -E 'ID_VENDOR=|ID_MODEL=|ID_SERIAL=|ID_SERIAL_SHORT=|ID_PATH='
```

Raw TF-Mini test:

```bash
sudo /opt/trafficlight/.venv/bin/python - <<'PY'
import serial
import time

PORT = "/dev/ttyUSB0"

ser = serial.Serial(
    PORT,
    115200,
    timeout=1
)

for i in range(30):
    data = ser.read(9)
    print(data.hex(" "))
    time.sleep(0.1)

ser.close()
PY
```

Expected:

```text
59 59 ...
```

Do not start full S1→S2 pair logic until one sensor raw frames are proven.

---

# 29. Adding More Displays Later

After Display1 passes:

```text
Pi
 │
LAN switch
 ├── D1 .11
 ├── D2 .12
 └── D3 .13
```

An unmanaged switch needs no software configuration.

Test order:

```text
D1 alone
→ switch + D1
→ D2
→ D3
```

If D1 works directly but fails after adding switch:
focus on switch/cabling.

---

# 30. Adding Four Sensors Later

After Sensor1 passes:

1. connect all 4 USB-RS485 adapters
2. inspect serial identity
3. run udev wizard
4. verify `/dev/traffic-S1..S4`
5. test each distance individually
6. only then enable pair/state logic

Do not rely on ttyUSB enumeration order.

---

# 31. Git / Source-of-Truth Rules

Windows notebook repository:

```text
C:\TPCAP_TRAFFIC_LIGHT\AutoEcar_git
```

Pi repository:

```text
~/trafficlight
```

Workflow:

```text
Windows/Copilot
→ edit
→ build/test
→ commit
→ push origin trafficlight

Pi
→ git pull origin trafficlight
```

For ESP-only firmware edits:
Pi does not need an immediate pull to flash ESP.

The ESP is built/flashed from Windows.

But eventually commit/push so all sources remain synchronized.

---

# 32. Important “Do Not Regress” List

Copilot must NOT:

- revert W5500 pins to 10/11/12/13 old mapping
- remove W5500 RST GPIO4 without reason
- revert flash to 8 MB
- remove USB CDC build flags
- remove Adafruit GFX dependency if another library needs it
- change MQTT topics casually
- change Display1 IP away from 10.77.0.11
- bind Mosquitto to Wi-Fi / 0.0.0.0 casually
- change HUB75 pins without schematic evidence
- use panel `OUT` instead of `IN`
- re-enable default GFX text renderer as the only traffic text path
- modify traffic-state logic while fixing display text
- enable trafficlight production service before S1-S4 mapping is complete
- rely on `/dev/ttyUSB0..3` permanently

---

# 33. Confirmed Real Root Causes Found During Bring-Up

These were real field bugs, not theoretical issues:

## A. PlatformIO missing dependency
Missing:

```text
intelhex
Adafruit_GFX.h
```

Fixed.

## B. ESP flash-size mismatch
Binary header expected 8 MB while hardware had 4 MB.

Error:

```text
Detected size(4096k) smaller than the size in the binary image header(8192k)
```

Fixed by 4 MB PlatformIO override.

## C. USB Serial debug not visible
Needed:

```ini
-DARDUINO_USB_MODE=1
-DARDUINO_USB_CDC_ON_BOOT=1
```

Debug Serial now works.

## D. W5500 showed `NO_HARDWARE`
Root cause was wrong ESP-HUB75 SPI pin assumption.

Correct schematic mapping:

```text
CS   GPIO21
MOSI GPIO13
SCK  GPIO12
MISO GPIO11
```

Fixed and confirmed working.

## E. Panel stayed completely black
Root cause:

```text
ribbon connected to P5 OUT
```

Moving to P5 IN immediately fixed display output.

## F. Traffic text malformed
Full-screen fill is clean.
Default GFX text rendering is not reliable on current real panel setup.
Current direction is custom bitmap rendering.

---

# 34. Current Completion Estimate

Software architecture:

```text
~85–90% complete
```

Real hardware integration:

```text
Display network path     PASS
P5 color rendering       PASS
Traffic text             IN PROGRESS
Sensor raw input         NEXT
4-sensor mapping         PENDING
Full vehicle test        PENDING
```

---

# 35. Copilot Instructions

You are working on an existing system that now has real hardware evidence.

Before changing anything:

1. inspect git status
2. inspect current `main.cpp`
3. inspect `device_config.h`
4. inspect `platformio.ini`
5. inspect current diff
6. preserve uncommitted confirmed fixes

Highest priority:

```text
Finish reliable CAUTION/STOP rendering
without breaking:
W5500
MQTT
HUB75
Serial debug
color fills
```

Do not refactor unrelated Pi traffic logic now.

After any ESP change:

```text
build display1
```

using:

```text
C:\Users\SmartFactory\.platformio\penv\Scripts\platformio.exe
```

Do not waste time searching PATH.

Do not automatically flash hardware unless explicitly instructed.

Do not automatically push until diff and build are reviewed.

Final report should include:

```text
FILES_MODIFIED:
BUILD_STATUS:
CRITICAL_CHANGES:
CONFIRMED_BEHAVIOR_PRESERVED:
UNTESTED_HARDWARE_ASSUMPTIONS:
NEXT_FIELD_TEST:
COMMIT_READY:
```

---

# 36. Immediate Field Check After Next ESP Build

After flashing Display1:

```cmd
C:\Users\SmartFactory\.platformio\penv\Scripts\platformio.exe device monitor --port COM10 --baud 115200
```

Serial must still show:

```text
ETH=W5500
LINK=ON
IP=10.77.0.11
MQTT=ON
```

Then Pi:

```bash
cd ~/trafficlight
bash scripts/display_test.sh
```

Required visible behavior:

```text
GREEN:
full green
no normal text

YELLOW:
full yellow
readable CAUTION

RED:
full red
readable STOP

FAULT:
small fault indication only

RETURN:
green
no normal text
```

If custom bitmap text still fails while solid colors remain correct:
do not randomly change network or SPI configuration.
Focus only on pixel rendering / panel coordinate behavior.

---

# END OF HANDOFF

This file represents the latest known state as of 2026-09-04.
Real hardware evidence overrides earlier assumptions.
