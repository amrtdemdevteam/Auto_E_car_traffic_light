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
1. Move/drive forward through S4 -> S3: all displays become yellow.
2. Continue S2 -> S1: all displays become red immediately.
3. Confirm red remains while S1 is occupied, even beyond 5 s.
4. Clear S1 and confirm RETURN yellow begins only after S1 stays clear for 1 s.
5. Confirm yellow return remains 5 s.
6. Confirm green after convoy is clear.
7. Repeat reverse S3 -> S4: must NOT create a new yellow trigger.
8. Repeat reverse S1 -> S2: must NOT create a new red trigger.

## Minute 35–45: E-Car + dollies
Use the actual E-Car and tow configuration. Confirm gaps between cab/body/hitches/dollies do not make the light flicker green. If necessary, tune only:

```json
"gap_hold_s": 1.2,
"pair_window_s": 5.0,
"red_clear_delay_s": 1.0
```

Change one value at a time and keep notes.

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
