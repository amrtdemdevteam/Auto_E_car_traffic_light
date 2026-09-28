# Engineering Review — Bugs Fixed and Remaining Hardware Check

## Software bugs found during re-review and fixed

1. **False yellow on first sensor alone** — previous pair detector exposed `active=true` when either sensor was occupied, so IDLE could enter YELLOW before the second pair member confirmed direction. Fixed: pair becomes active only after a valid field sequence: S4 -> S3 for yellow or S2 -> S1 for red.
2. **MQTT publish dedupe ineffective** — timestamp was included before payload comparison, causing a publish every loop (~20 Hz). Fixed: state/fault key is compared separately; normal heartbeat is 1 Hz.
3. **Mosquitto remote listener missing** — Mosquitto 2.x can run localhost-only without an explicit listener. Added `/etc/mosquitto/conf.d/trafficlight.conf` bound to `10.77.0.1:1883`.
4. **USB sensor did not recover after unplug/replug** — serial port was only opened at startup. Added automatic close/reopen every 2 s after errors or missing device.
5. **Reverse-direction oscillation could later form a false forward sequence** — added reverse lockout until both pair sensors clear.
6. **Service-user collision** — Pi login user is already `trafficlight`; service now uses dedicated `trafficlightsvc`.
7. **Installer could delete itself if rerun from `/opt/trafficlight`** — install now stages source before replacing application directory.
8. **Wi-Fi setup depended on SSID being visible** — setup now creates persistent NetworkManager profiles; passwords stay only on Pi.
9. **No display link health** — ESP publishes online/offline via MQTT Last Will and shows `LINK ERR` after controller command timeout.
10. **No fast field tools** — added self-test, preflight, display test, USB mapping wizard, and 60-minute Friday plan.

## ESP-HUB75 board mapping recheck

The BOM hyperlink identifies the display controller as **ArtronShop ESP-HUB75 product 03K26**. The vendor page points to Adafruit_Protomatter and an ESP-HUB75 64x32 example. A published ESP-HUB75 example gives the board routing as:

- RGB: `42, 41, 40, 39, 38, 37`
- Address A-D: `48, 36, 45, 35`
- CLK: `2`
- LAT: `47`
- OE: `14`

These pins are explicitly configured in `esp32_display/src/main.cpp`. The field-proven W5500 SPI allocation is CS=21, MOSI=13, SCK=12, MISO=11, RST=4. Do not replace it with Arduino UNO Ethernet Shield examples. The purchased 64x32 P5 panel uses four address lines, so E is disabled (`-1`).

Vendor/product source: https://www.artronshop.co.th/product/808/esp-hub75
Published ESP-HUB75 64x32 example: https://gist.github.com/maxpromer/18cea4e9d25aca5689818260e655a43f

**Still bench-test one board + one panel before Friday.** This is now a verification step rather than an unknown pin-map blocker.

## Recommended tuning policy
- Do not change threshold, debounce, gap hold, and pair window all at once.
- First confirm sensor distance/strength.
- Then tune `gap_hold_s` using actual cab/body/dolly gaps.
- Then tune `pair_window_s` only if valid forward passages are missed.
- Keep RED=5 s and RETURN=5 s fixed during acceptance unless the process owner intentionally changes them.
