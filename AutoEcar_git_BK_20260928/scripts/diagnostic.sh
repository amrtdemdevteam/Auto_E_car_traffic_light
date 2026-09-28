#!/usr/bin/env bash
set -u
echo '=== OS ==='; cat /etc/os-release | head
echo '=== HOST ==='; hostnamectl
echo '=== NETWORK ==='; ip -br addr; ip route
echo '=== WIFI ==='; command -v nmcli >/dev/null && nmcli -t -f NAME,TYPE,DEVICE connection show --active || true
echo '=== USB SERIAL ==='; "$(dirname "$0")/detect_usb_rs485.sh" || true
echo '=== SERVICES ==='; systemctl --no-pager --full status mosquitto trafficlight 2>/dev/null || true
echo '=== MQTT ==='; command -v mosquitto_sub >/dev/null && timeout 2 mosquitto_sub -h 10.77.0.1 -t 'factory/trafficlight/#' -v || true
