#!/usr/bin/env bash
set -euo pipefail
if ! command -v nmcli >/dev/null 2>&1; then
  echo "NetworkManager/nmcli not found. Configure Wi-Fi manually."
  exit 1
fi

IFS=',' read -r -a SSIDS <<< "${WIFI_SSIDS:-}"
if [[ ${#SSIDS[@]} -eq 0 || -z "${SSIDS[0]}" ]]; then
  read -r -p "Maintenance Wi-Fi SSIDs, comma-separated (leave blank to skip): " SSID_INPUT
  IFS=',' read -r -a SSIDS <<< "$SSID_INPUT"
fi

add_profile() {
  local ssid="$1" priority="$2" pass
  ssid="${ssid# }"
  ssid="${ssid% }"
  [[ -n "$ssid" ]] || return 0
  read -r -s -p "Password for ${ssid} (leave blank to skip): " pass; echo
  [[ -n "$pass" ]] || return 0
  if nmcli -t -f NAME con show | grep -Fxq "$ssid"; then
    sudo nmcli con modify "$ssid" wifi.ssid "$ssid" wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$pass" connection.autoconnect yes connection.autoconnect-priority "$priority"
  else
    sudo nmcli con add type wifi ifname wlan0 con-name "$ssid" ssid "$ssid"
    sudo nmcli con modify "$ssid" wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$pass" ipv4.method auto ipv6.method auto connection.autoconnect yes connection.autoconnect-priority "$priority"
  fi
}

priority=30
for ssid in "${SSIDS[@]}"; do
  add_profile "$ssid" "$priority"
  priority=$((priority - 10))
done
sudo nmcli radio wifi on
for ssid in "${SSIDS[@]}"; do
  ssid="${ssid# }"
  ssid="${ssid% }"
  [[ -n "$ssid" ]] || continue
  sudo nmcli con up "$ssid" 2>/dev/null && break || true
done

echo "Wi-Fi profiles saved only on this Pi. No password is written to the Git repo."
echo "Traffic control and display MQTT use eth0 10.77.0.0/24, not Wi-Fi."
