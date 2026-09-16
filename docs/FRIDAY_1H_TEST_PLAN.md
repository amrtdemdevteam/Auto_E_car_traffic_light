# Friday — 60 Minute Field Test Plan

The goal is to spend the one-hour window validating hardware behavior, not installing/debugging basics.

## Before Friday (must be done in advance)
- Pi repo cloned and `sudo ./install.sh` completed.
- Wi-Fi maintenance profile configured if needed.
- All four USB-RS485 adapters mapped to `/dev/traffic-S1..S4`.
- All ESP32 display boards flashed and numbered D1..D7.
- HUB75 pin mapping verified by solid-color/display test.
- Ethernet switch, 5 V supply, fuse, and wiring powered and checked.
- `scripts/self_test.sh` passes.

## Minute 0–5: preflight

```bash
sudo /opt/trafficlight/scripts/friday_preflight.sh
```

Expected: `FAIL=0`.

## Minute 5–10: displays only

```bash
/opt/trafficlight/scripts/display_test.sh
```

Verify every connected display changes together:
1. GO green
2. CAUTION yellow
3. STOP red
4. GO + `ERR:S2`
5. GO green

## Minute 10–20: sensors individually

```bash
sudo systemctl stop trafficlight
sudo journalctl -u trafficlight -f
```

Then start service and pass an object below each sensor. Confirm sensor name, distance, and no unexpected offline warning.

Recommended live command:

```bash
sudo systemctl start trafficlight
sudo journalctl -u trafficlight -f
```

## Minute 20–35: direction + state sequence
1. A new S4 rising edge must make all displays RED immediately; no S4 -> S3 pair is required.
2. With S4 missed, a new S3 rising edge must make all displays RED immediately.
3. Confirm S1 clear before arrival does not release RED, even beyond 5 s.
4. After S1 is occupied, keep a vehicle/convoy at S2 or S3 and confirm RED remains held.
5. Clear all S1-S4 sensors and confirm RED remains for only the configured `red_clear_delay_s` (1 s in the default config) after fresh S1-S4 confirmation, then goes directly to GREEN/IDLE.
6. Confirm no RETURN YELLOW phase or 5-second delay occurs on the production RED release path.
7. During RED, repeat S3/S4 edges and confirm they hold corridor release without restarting the RED state cycle.
8. S1/S2 rising edges must not create RED entry; the legacy RETURN state is not part of the production RED release path.

## Minute 35–45: E-Car + dollies
Use the actual E-Car and tow configuration. Confirm gaps between cab/body/hitches/dollies do not make the light flicker green. If necessary, tune only:

```json
"gap_hold_s": 1.2,
"pair_window_s": 5.0,
"red_clear_delay_s": 1.0
```

Do not change thresholds, debounce, `gap_hold_s`, MQTT settings, or display mapping during this acceptance test.

## Minute 45–52: fault tests
- Unplug one sensor USB-RS485: within ~2 s every display should keep its main state and show `ERR:Sx`.
- Replug: reader should reopen automatically; after stable frames, fault should clear.
- Unplug one display LAN cable: only that display should eventually show `LINK ERR`; other displays continue.

## Minute 52–60: reboot/autostart and final save

```bash
sudo reboot
```

After boot:

```bash
systemctl is-active mosquitto trafficlight
sudo journalctl -u trafficlight -b --no-pager | tail -100
```

Confirm displays return automatically and save the final `/etc/trafficlight/settings.json` values into the test record.
