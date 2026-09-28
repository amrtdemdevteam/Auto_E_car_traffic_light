#!/usr/bin/env bash
set -u

section(){ printf '\n== %s ==\n' "$*"; }
mapping_method(){
  local sensor="$1"
  local rules="/etc/udev/rules.d/99-trafficlight-sensors.rules"
  if [[ ! -f "$rules" ]]; then
    printf 'NOT_CONFIGURED'
  elif grep -q "SYMLINK+=\"traffic-$sensor\"" "$rules" && grep "SYMLINK+=\"traffic-$sensor\"" "$rules" | grep -q 'ATTRS{serial}'; then
    printf 'SERIAL_BASED'
  elif grep -q "SYMLINK+=\"traffic-$sensor\"" "$rules" && grep "SYMLINK+=\"traffic-$sensor\"" "$rules" | grep -q 'ENV{ID_PATH}'; then
    printf 'PATH_BASED'
  else
    printf 'UNKNOWN'
  fi
}

section "Host"
hostnamectl 2>/dev/null || hostname || true
date -Is 2>/dev/null || date || true

section "Services"
systemctl --no-pager --full status trafficlight mosquitto 2>/dev/null || true

section "Recent trafficlight journal"
journalctl -u trafficlight -n 120 --no-pager 2>/dev/null || true

section "Recent mosquitto journal"
journalctl -u mosquitto -n 80 --no-pager 2>/dev/null || true

section "Serial devices"
ls -l /dev/ttyUSB* /dev/ttyACM* /dev/traffic-S* 2>/dev/null || true

section "traffic-S symlinks"
for sensor in S1 S2 S3 S4; do
  method="$(mapping_method "$sensor")"
  if [[ -e "/dev/traffic-$sensor" ]]; then
    printf '[PASS] /dev/traffic-%s -> %s mapping=%s\n' "$sensor" "$(readlink -f "/dev/traffic-$sensor" 2>/dev/null || echo unknown)" "$method"
  else
    printf '[FAIL] /dev/traffic-%s missing mapping=%s\n' "$sensor" "$method"
  fi
done

section "USB serial adapter enumeration"
"$(dirname "$0")/detect_usb_rs485.sh" 2>/dev/null || true