# Traffic Light — Final Release Notes

## Final display rule
- Field deployment: D1–D3; software still supports IDs 1–7.
- GREEN: upward green arrow on black.
- YELLOW: filled upward yellow triangle on black.
- RED: thick centered red X on black.
- RETURN: same as YELLOW.
- Precedence: RED/STOP → red X; YELLOW/CAUTION → yellow triangle; effective fault / LINK ERR → yellow triangle; explicit GREEN/GO → green arrow; unknown → yellow triangle.
- Missing or incorrectly typed MQTT text/color fields no longer default to GO/green. MQTT schema and Pi publisher are unchanged.
- Fault details remain in diagnostics; symbol mode does not display fault badges. Healthy connected displays render the same Pi state.
- Canonical ESP project: `C:\TPCAP_TRAFFIC_LIGHT\AutoEcar_git\esp32_display`.
- Production builds: `display1_symbols`, `display2_symbols`, `display3_symbols`; symbol mode and scan/base 32/32 are enabled, bench mode is disabled.
- Field mapping remains physical 64×32 → DMA 128×16 with direct pixel writes, one panel, brightness 60, and unchanged HUB75/W5500 pins.

## Logic locked for Friday test
- TF-Mini Plus x4.
- Forward direction only: S4 -> S3 confirms Yellow, S2 -> S1 confirms Red.
- Timestamp window prevents raw simultaneous-AND dependency.
- Debounce + gap-hold merges cab/body/operator/dolly gaps into one convoy.
- A valid red pair overwrites Idle/Yellow/Return immediately; another red trigger while RED resets the clear timer.
- V1.1 RED holds until S1 is online, fresh, and continuously clear for 1 s, then RETURN yellow fixed 5 s.
- If the yellow convoy is still active after RETURN, continue Yellow without a green flash.
- Sensor failure does not force the Pi state Red; it is logged and displayed using the symbol fault precedence above.
- Special-junction priority logic is intentionally deferred.

## Friday rule
Do not change multiple timing parameters simultaneously. Verify sensor distance/strength first, then tune `gap_hold_s` only if the cab/dolly convoy is being split. Change `pair_window_s` only if a correct S4->S3 or S2->S1 passage is missed.

## v1.0.4-field — Friday field baseline
- Real travel direction is S4 -> S3 -> S2 -> S1.
- Production pair window is 5.0 s.
- Production TF-Mini range is 30..250 cm inclusive with strength >= 100.
- Display brightness is `MATRIX_BRIGHTNESS=60`.
- W5500 field mapping is CS=21, MOSI=13, SCK=12, MISO=11, RST=4.
- Maintenance Wi-Fi is runtime/site configuration; field deployment currently uses `Auto_ECar`, while traffic/display MQTT remains on isolated Ethernet `10.77.0.0/24`.

## v1.1 — RED release controlled by S1 clear
- RED no longer exits on a fixed 5 s timer.
- After S2 -> S1 triggers RED, S1 is the direct RED release authority.
- RED holds and resets its clear timer while S1 is occupied, offline, stale, unknown, or has a future timestamp.
- Known residual risk, unchanged: restarting the service with a vehicle already on S1 may not reconstruct RED without a new S2 -> S1 pair.
- RETURN yellow starts only after S1 remains online, fresh, and continuously clear for `red_clear_delay_s=1.0`; freshness is gated by `red_exit_sensor_fresh_timeout_s=0.5`.

## 1.0.1-final — Raspberry Pi Bookworm install hotfix
- Removed duplicate Mosquitto `persistence_location` directives that prevented the broker from starting on Debian 12 Bookworm.
- Installer now updates `/etc/hosts` when hostname changes to `trafficlight`, preventing `sudo: unable to resolve host trafficlight`.
- Installer runs unit tests inside the production virtual environment after installing runtime dependencies.
- `scripts/self_test.sh` now prefers the production virtual environment and safely skips dependency-based tests before installation.

## v1.0.2-final — installer hardening from real Pi test

- Fixed Debian Bookworm Mosquitto `Duplicate persistence_location` failure permanently.
- Fixed hostname change order so `/etc/hosts` is updated before `hostnamectl`.
- `pytest` is installed inside the production virtualenv before tests run.
- Installer performs Python unit tests, JSON validation, shell syntax checks, Mosquitto active/listener checks, and a real MQTT pub/sub smoke test.
- Installation does not require sensors, USB-RS485 adapters, Ethernet cable, LAN switch, or ESP displays to be connected.
- `trafficlight.service` is enabled but deliberately left stopped until S1-S4 USB mapping is completed.
- Installer is safe to rerun and preserves an existing `/etc/trafficlight/settings.json`.
- Before sensor mapping, `trafficlight.service` is now disabled as well as stopped, so an accidental reboot cannot start the controller against unmapped `/dev/traffic-S*` devices.
- The USB mapping wizard now installs its own udev rules and enables/starts autostart only after all four stable sensor symlinks are verified.

## 1.0.3-final
- Fixes a Raspberry Pi Bookworm boot race found on real hardware: Mosquitto could start before NetworkManager assigned `10.77.0.1/24` to `eth0`, then fail because the listener is bound to that address.
- Installer now installs `/etc/systemd/system/mosquitto.service.d/trafficlight-network.conf` and waits (up to 60 s) for `10.77.0.1/24` before Mosquitto starts.
- MQTT remains bound only to the private display LAN instead of exposing the anonymous broker on maintenance Wi-Fi.
