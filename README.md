# E-Car Traffic Light Controller — Normal Junction V1

Repository for Raspberry Pi 4B + four TF-Mini Plus sensors + independent 64×32 HUB75 displays. Current field deployment is D1–D3; software still supports display IDs 1–7.

## System behavior
- Real vehicle travel direction is S4 -> S3 -> S2 -> S1.
- S4 -> S3 within `pair_window_s` confirms approach -> all displays YELLOW.
- S2 -> S1 confirms red zone -> all displays RED immediately.
- Reverse order is ignored.
- Debounce + gap hold merges cab/body/dolly gaps into one convoy.
- RED holds until S1 is online, fresh, and continuously clear for 1 s; RETURN yellow fixed 5 s.
- If a yellow convoy is still active at end of RETURN, stay YELLOW with no green flash.
- Raspberry Pi is the only traffic-state authority; ESP32 receives MQTT state and renders symbols.
- Sensor offline does not force the Pi state to RED. Displays retain explicit RED/STOP; otherwise faults render a yellow triangle.
- MQTT disconnect or command timeout produces effective `LINK ERR` with the same symbol precedence. Fault details remain in diagnostics, not on-screen text.
- Unknown or missing display state renders yellow; green requires explicit `green` color or `GO` text.
- Special junction is intentionally deferred.

See:
- [`docs/LOGIC.md`](docs/LOGIC.md)
- [`docs/OPERATOR_GUIDE.md`](docs/OPERATOR_GUIDE.md)
- [`docs/FRIDAY_1H_TEST_PLAN.md`](docs/FRIDAY_1H_TEST_PLAN.md)
- [`docs/REVIEW_AND_RISKS.md`](docs/REVIEW_AND_RISKS.md)

## Raspberry Pi target
Observed Pi: Debian 12 Bookworm, kernel 6.6 Raspberry Pi arm64. Login user may remain `trafficlight`; system service uses separate user `trafficlightsvc`. Installer sets hostname to `trafficlight`.

## Network
- Wi-Fi: maintenance/VNC/SSH only. Field deployment currently uses `Auto_ECar`, but Wi-Fi is site/runtime configuration and traffic control does not depend on it.
- Ethernet: isolated display network.
  - Pi: `10.77.0.1/24`
  - Field D1/D2/D3: `10.77.0.11`, `10.77.0.12`, `10.77.0.13`; additional IDs through D7 remain supported.
  - MQTT: Pi port 1883

## Install

```bash
git clone <YOUR_REPO_URL> ~/trafficlight
cd ~/trafficlight
sudo ./install.sh
```

Optional Wi-Fi:

```bash
sudo /opt/trafficlight/scripts/setup_wifi.sh
```

Map USB-RS485 adapters:

```bash
sudo /opt/trafficlight/scripts/generate_udev_rules.sh
sudo cp /tmp/99-sensors.rules /etc/udev/rules.d/99-sensors.rules
sudo udevadm control --reload-rules
sudo udevadm trigger
# replug USB adapters if symlinks do not appear
ls -l /dev/traffic-S*
```

Preflight and start:

```bash
sudo /opt/trafficlight/scripts/friday_preflight.sh
sudo systemctl start trafficlight
sudo journalctl -u trafficlight -f
```

Fresh install state: `install.sh` installs `trafficlight.service` but intentionally leaves it disabled/stopped until S1-S4 sensor mapping is complete. After sensor mapping/field deployment, `trafficlight.service` should be enabled and active; Mosquitto should remain enabled and active.

## ESP32 displays
Canonical production project: `C:\TPCAP_TRAFFIC_LIGHT\AutoEcar_git\esp32_display`. Each environment derives its fixed IP from the display ID. Build the field environments explicitly (the legacy default `display1` is not the production symbol build):

```bash
cd esp32_display
pio run -e display1_symbols
pio run -e display2_symbols
pio run -e display3_symbols
```

D1–D3 show an upward green arrow, filled upward yellow triangle (including RETURN), or thick centered red X, all on black. Production environments enable `DISPLAY_SYMBOL_MODE=1`, `HUB75_SCAN_PROBE=32`, and `HUB75_SCAN_PIXEL_BASE=32`; `SYMBOL_BENCH_TEST` is disabled. Optional `display1_symbols_bench` through `display3_symbols_bench` cycle locally and are not production.

All displays subscribe to `factory/trafficlight/junction/1/display` on `10.77.0.1:1883`; status is published to `factory/trafficlight/junction/1/display/<DISPLAY_ID>/status`. Healthy connected displays render the same Pi command; local link faults can change an individual display to yellow.

The field-confirmed physical 64×32 panel uses a 128×16 DMA canvas, one panel, and brightness 60. Symbol pixels use the confirmed mapping directly through `matrix->drawPixel()`, without a second scan-mapper pass.

### Mandatory bench check before Friday
The BOM identifies the exact controller as ArtronShop ESP-HUB75 product 03K26. The field-proven ESP32-S3 + Mini W5500 mapping is CS=21, MOSI=13, SCK=12, MISO=11, RST=4. Do not replace it with Arduino UNO Ethernet Shield examples. Brightness is `MATRIX_BRIGHTNESS=60`.

## Tests

```bash
./scripts/self_test.sh
```

Current repository unit suite covers directional pair logic, reverse lockout, offline pending reset, state timing, debounce, dolly gap hold, and new-vehicle gap behavior.
