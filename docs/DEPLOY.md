# Deploy checklist

1. Confirm Pi is Debian 12 Bookworm arm64.
2. Clone repo to the Pi.
3. Run `sudo ./install.sh`.
4. Optional maintenance Wi-Fi: configure site Wi-Fi on the Pi, or run `sudo /opt/trafficlight/scripts/setup_wifi.sh` and enter SSIDs when prompted. Field deployment currently uses `Auto_ECar` for maintenance only.
5. Plug the four USB-RS485 adapters one by one and run `/opt/trafficlight/scripts/detect_usb_rs485.sh`.
6. Build `/etc/udev/rules.d/99-sensors.rules` from the template using the real adapter serial numbers.
7. Edit `/etc/trafficlight/settings.json` if production timing/range differs from the repo defaults. RED release is controlled by S1 clear state and `red_clear_delay_s`, not by a fixed red timer.
8. Flash each ESP32 display with unique IP 10.77.0.11 through 10.77.0.17.
9. Start: `sudo systemctl start trafficlight`.
10. Observe: `sudo journalctl -u trafficlight -f` and `mosquitto_sub -h 10.77.0.1 -t 'factory/trafficlight/#' -v`.
11. Reboot and verify autostart.

## VNC note
The current Pi output shows RealVNC service files installed but service disabled/inactive. `XDG_CURRENT_DESKTOP` being blank in an SSH shell alone does not prove that a desktop environment is absent. The traffic-light service does not depend on VNC or a desktop.
