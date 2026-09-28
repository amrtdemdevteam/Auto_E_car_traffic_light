# Installer behavior — v1.0.2-final

This release is hardened from testing on the real Raspberry Pi 4 (Debian 12 Bookworm, arm64).

`sudo ./install.sh` is designed to complete successfully **with no sensors or ESP displays connected**.

It automatically:

1. Installs Python, venv, pytest, Mosquitto, Git and NetworkManager.
2. Creates `/opt/trafficlight`, `/etc/trafficlight`, and `/var/log/trafficlight`.
3. Builds the production Python virtual environment and installs runtime + test dependencies.
4. Runs all unit tests before proceeding.
5. Safely changes hostname to `trafficlight` and updates `/etc/hosts` first.
6. Configures `eth0` as `10.77.0.1/24`. A physical Ethernet link is **not** required during installation.
7. Writes a minimal Debian Bookworm-compatible Mosquitto drop-in. It deliberately does not duplicate `persistence_location`.
8. Starts Mosquitto and performs a real MQTT publish/subscribe loopback test.
9. Installs `trafficlight.service` but leaves it disabled/stopped until S1-S4 are mapped; the mapping wizard enables autostart after successful verification.
10. Runs a final installation self-check.

## Why the controller is not started immediately

The production config expects `/dev/traffic-S1` through `/dev/traffic-S4`. Those symlinks can only be created after the four physical USB-RS485 adapters are plugged in and identified. Starting the controller before mapping would only generate expected sensor-offline faults.

After hardware is connected, run:

```bash
sudo /opt/trafficlight/scripts/generate_udev_rules.sh
/opt/trafficlight/scripts/friday_preflight.sh
sudo journalctl -u trafficlight -f
```

### Mosquitto boot ordering (v1.0.3)
Mosquitto is intentionally bound to `10.77.0.1:1883` so it is not exposed on maintenance Wi-Fi. On Raspberry Pi OS/Debian Bookworm with NetworkManager, the broker may otherwise start before the static Ethernet address exists. The installer therefore creates a systemd drop-in that waits for `eth0` to own `10.77.0.1/24` before starting Mosquitto. This also works when the Ethernet cable is not connected, as long as NetworkManager has activated the static profile and assigned the address.
