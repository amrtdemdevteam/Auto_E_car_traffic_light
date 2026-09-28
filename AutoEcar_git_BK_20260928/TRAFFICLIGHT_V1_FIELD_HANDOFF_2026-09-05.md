# E-Car Traffic Light V1 Field Handoff

Date: 2026-09-05  
Branch: `trafficlight`  
Status: current Friday field-working baseline

This document is the current V1 field reference. Older handoff notes may contain historical S1->S2 / S3->S4 direction assumptions and should not be used as production behavior.

## 1. System Architecture

```text
TF-Mini Plus S1..S4
        |
        | UART TTL -> RS485 -> USB-RS485
        v
Raspberry Pi controller
eth0 10.77.0.1/24
        |
        | traffic logic + MQTT publish
        v
Mosquitto 10.77.0.1:1883
        |
        | isolated Ethernet switch
        v
ESP32-S3 ESP-HUB75 displays with Mini W5500
        |
        v
P5 64x32 HUB75 panels
```

Wi-Fi is maintenance only. Traffic control and display MQTT use isolated Ethernet.

## 2. Physical Wiring Overview

- Sensors: TF-Mini Plus sensors feed UART TTL into RS485 transport and then Waveshare Industrial USB-RS485 adapters.
- Stable Pi devices: `/dev/traffic-S1`, `/dev/traffic-S2`, `/dev/traffic-S3`, `/dev/traffic-S4`.
- Display LAN: Pi `eth0` and all ESP displays are on `10.77.0.0/24`.
- Display controller: ESP-HUB75 ESP32-S3 plus external Mini W5500 Ethernet.
- HUB75 ribbon: connect ESP-HUB75 output to P5 panel `IN`, not `OUT`.

## 3. Pi / Sensor / ESP / MQTT Flow

- [raspberry_pi/trafficlight/sensor/tfmini.py](raspberry_pi/trafficlight/sensor/tfmini.py): `TFMiniReader.read_available()` parses TF-Mini frames.
- [raspberry_pi/trafficlight/sensor/sensor.py](raspberry_pi/trafficlight/sensor/sensor.py): `SensorState.ingest()` applies strength/range/debounce; `tick()` applies offline and gap hold.
- [raspberry_pi/trafficlight/sensor/sensor_manager.py](raspberry_pi/trafficlight/sensor/sensor_manager.py): `SensorManager.update()` opens stable ports and returns snapshots.
- [raspberry_pi/trafficlight/traffic/pair_detector.py](raspberry_pi/trafficlight/traffic/pair_detector.py): `DirectionalPairDetector.update()` accepts only fresh, physically valid ordered pairs.
- [raspberry_pi/trafficlight/traffic/state_machine.py](raspberry_pi/trafficlight/traffic/state_machine.py): `StateMachine.update()` controls IDLE/YELLOW/RED/RETURN timing.
- [raspberry_pi/trafficlight/display/display_manager.py](raspberry_pi/trafficlight/display/display_manager.py): `DisplayManager.publish()` sends retained MQTT display commands.
- [esp32_display/src/main.cpp](esp32_display/src/main.cpp): `callback()` parses MQTT JSON; `drawScreen()` renders solid colors.

## 4. Current Decision Logic

Real travel direction:

```text
S4 -> S3 -> S2 -> S1
```

Yellow trigger:

```text
S4 -> S3 within pair_window_s=5.0
```

Red trigger:

```text
S2 -> S1 within pair_window_s=5.0
```

Red release:

```text
S1 must be online, fresh, and continuously clear for red_clear_delay_s=1.0 before RETURN YELLOW
```

Reverse directions are invalid:

```text
S3 -> S4 must not create YELLOW
S1 -> S2 must not create RED
```

## 5. Field Parameters

Production seed values live in [config/settings.example.json](config/settings.example.json). Runtime values on the Pi live in `/etc/trafficlight/settings.json`.

```json
{
  "sensor": {
    "baudrate": 115200,
    "min_detect_cm": 30,
    "max_detect_cm": 250,
    "min_strength": 100,
    "debounce_ms": 200,
    "gap_hold_s": 1.2,
    "offline_timeout_s": 2.0,
    "recover_stable_s": 1.0,
    "reopen_interval_s": 2.0
  },
  "direction": {
    "pair_window_s": 5.0,
    "yellow_order": ["S4", "S3"],
    "red_order": ["S2", "S1"]
  },
  "timing": {
    "red_duration_s": 5.0,
            "red_clear_delay_s": 1.0,
            "red_exit_sensor_fresh_timeout_s": 0.5,
    "return_yellow_s": 5.0,
    "yellow_clear_delay_s": 5.0
  }
}
```

`red_duration_s` is retained as a legacy/reference value. V1.1 RED release is controlled by direct S1 occupancy, `red_clear_delay_s`, and `red_exit_sensor_fresh_timeout_s`; S1 offline/stale/unknown holds RED fail-safe.

Raw detection is true only when `strength >= 100` and `30 <= distance_cm <= 250`.

## 6. Where To Edit Each Parameter

- Sensor range/defaults: [config/settings.example.json](config/settings.example.json), deployed runtime `/etc/trafficlight/settings.json`.
- Direction and pair window: [config/settings.example.json](config/settings.example.json), [raspberry_pi/trafficlight/traffic/pair_detector.py](raspberry_pi/trafficlight/traffic/pair_detector.py).
- Traffic timing: [config/settings.example.json](config/settings.example.json), [raspberry_pi/trafficlight/traffic/state_machine.py](raspberry_pi/trafficlight/traffic/state_machine.py).
- MQTT broker/topic defaults: [config/settings.example.json](config/settings.example.json), [raspberry_pi/trafficlight/display/display_manager.py](raspberry_pi/trafficlight/display/display_manager.py).
- ESP W5500 pins and brightness: [esp32_display/include/device_config.h](esp32_display/include/device_config.h).
- ESP reset/Ethernet/rendering: [esp32_display/src/main.cpp](esp32_display/src/main.cpp).
- Display build IDs/IPs: [esp32_display/platformio.ini](esp32_display/platformio.ini).

## 7. W5500 ESP32-S3 Pin Mapping

This is the field-proven ESP-HUB75 ESP32-S3 mapping. Do not replace it with Arduino UNO Ethernet Shield examples.

```cpp
#define W5500_CS   21
#define W5500_MOSI 13
#define W5500_SCK  12
#define W5500_MISO 11
#define W5500_RST  4
```

Expected reset/Ethernet order in [esp32_display/src/main.cpp](esp32_display/src/main.cpp):

```cpp
pinMode(W5500_RST, OUTPUT);
digitalWrite(W5500_RST, LOW);
delay(10);
digitalWrite(W5500_RST, HIGH);
delay(200);
SPI.begin(W5500_SCK, W5500_MISO, W5500_MOSI, W5500_CS);
delay(100);
Ethernet.init(W5500_CS);
```

## 8. HUB75 And Brightness

Known-good HUB75 pin order:

```text
R1,G1,B1,R2,G2,B2,A,B,C,D,E,LAT,OE,CLK
42,41,40,39,38,37,48,36,45,35,-1,47,14,2
```

Current production display behavior is solid full-screen GREEN / YELLOW / RED. Experimental geometry/text test modes remain disabled for production.

Brightness:

```cpp
#define MATRIX_BRIGHTNESS 60
matrix->setBrightness8(MATRIX_BRIGHTNESS);
```

## 9. Display IPs

Display IP is derived from `10.77.0.(10 + DISPLAY_ID)`.

| Environment | DISPLAY_ID | IP |
|---|---:|---|
| display1 | 1 | 10.77.0.11 |
| display2 | 2 | 10.77.0.12 |
| display3 | 3 | 10.77.0.13 |
| display4 | 4 | 10.77.0.14 |
| display5 | 5 | 10.77.0.15 |
| display6 | 6 | 10.77.0.16 |
| display7 | 7 | 10.77.0.17 |

## 10. MQTT Topics

Command topic:

```text
factory/trafficlight/junction/1/display
```

Display status topics:

```text
factory/trafficlight/junction/1/display/<DISPLAY_ID>/status
```

The Pi uses Paho MQTT 2.x callback API and must keep `self.connected = (reason_code == 0)`.

## 11. Logic Flow Diagrams

Yellow:

```text
[TF-Mini S4]
      |
      v
<30..250 cm AND strength >=100?>
      |
     YES
      v
[occupied S4]
      |
      v
<then S3 within 5 sec?>
      |
     YES
      v
[YELLOW]
```

Files: [tfmini.py](raspberry_pi/trafficlight/sensor/tfmini.py) `TFMiniReader`, [sensor.py](raspberry_pi/trafficlight/sensor/sensor.py) `SensorState`, [pair_detector.py](raspberry_pi/trafficlight/traffic/pair_detector.py) `DirectionalPairDetector`, config key `direction.yellow_order`.

Red:

```text
[TF-Mini S2]
      |
      v
<valid detection?>
      |
     YES
      v
[occupied S2]
      |
      v
<then S1 within 5 sec?>
      |
     YES
      v
[RED while S1 occupied]
      |
      v
<S1 clear for 1 sec?>
      |
     YES
      v
[RETURN YELLOW 5 sec]
      |
      v
<yellow convoy still active?>
   YES / NO
    |     |
 YELLOW GREEN
```

Files: [sensor.py](raspberry_pi/trafficlight/sensor/sensor.py) `SensorState`, [pair_detector.py](raspberry_pi/trafficlight/traffic/pair_detector.py) `DirectionalPairDetector`, [state_machine.py](raspberry_pi/trafficlight/traffic/state_machine.py) `StateMachine`, config keys `direction.red_order`, `timing.red_duration_s`, `timing.return_yellow_s`.

## 12. Autostart / Service Notes

- `mosquitto.service` should be enabled and active on deployed production Pis.
- `trafficlight.service` should be enabled and active after sensor mapping.
- The fresh installer intentionally leaves `trafficlight.service` disabled/stopped until `/dev/traffic-S1..S4` mappings are verified.
- The USB mapping wizard enables and starts `trafficlight.service` after all four stable sensor links exist.

## 13. Wi-Fi Maintenance Note

Field deployment currently uses `Auto_ECar` for maintenance/VNC/SSH. Wi-Fi credentials are runtime/site configuration and must not be committed. Traffic logic and display MQTT do not depend on Wi-Fi.

## 14. Troubleshooting Commands

```bash
ip -br addr
cat /sys/class/net/eth0/carrier
systemctl is-active mosquitto trafficlight
systemctl is-enabled mosquitto trafficlight
sudo journalctl -u trafficlight -f
sudo journalctl -u mosquitto -n 100 --no-pager
mosquitto_sub -h 10.77.0.1 -t 'factory/trafficlight/#' -v
/opt/trafficlight/scripts/friday_preflight.sh
/opt/trafficlight/scripts/display_network_debug.sh
```

## 15. Build / Flash Commands

Build only:

```bash
cd esp32_display
C:/Users/SmartFactory/.platformio/penv/Scripts/platformio.exe run -e display1
C:/Users/SmartFactory/.platformio/penv/Scripts/platformio.exe run -e display2
C:/Users/SmartFactory/.platformio/penv/Scripts/platformio.exe run -e display3
```

Flash only the intended display environment when hardware is connected and identified. Do not flash during software audit/build validation.

## 16. Files-To-Edit Quick Reference

- [config/settings.example.json](config/settings.example.json): deploy seed config.
- `/etc/trafficlight/settings.json`: live deployed config on the Pi.
- [raspberry_pi/trafficlight/traffic/pair_detector.py](raspberry_pi/trafficlight/traffic/pair_detector.py): direction pair validation.
- [raspberry_pi/trafficlight/traffic/state_machine.py](raspberry_pi/trafficlight/traffic/state_machine.py): state timing behavior.
- [esp32_display/include/device_config.h](esp32_display/include/device_config.h): W5500 pins, display IP derivation, brightness.
- [esp32_display/src/main.cpp](esp32_display/src/main.cpp): W5500 reset/Ethernet and HUB75 rendering.
- [esp32_display/platformio.ini](esp32_display/platformio.ini): display environments and ESP32-S3 build flags.

## 17. Known Deferred Items

- Special junction priority logic is intentionally deferred.
- Display4..Display7 are configured but may not be physically installed at every field stage.
- Maintenance Wi-Fi is configured on-site and may differ by plant/network policy.

## 18. Recovery / Reinstall Notes

```bash
sudo ./install.sh
sudo /opt/trafficlight/scripts/generate_udev_rules.sh
/opt/trafficlight/scripts/friday_preflight.sh
sudo systemctl restart mosquitto trafficlight
sudo journalctl -u trafficlight -n 100 --no-pager
```

Installer behavior is intentionally different from deployed production state: the installer can finish without sensors and leaves the controller stopped until sensor mapping is complete.