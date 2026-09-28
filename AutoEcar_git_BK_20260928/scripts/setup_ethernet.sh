#!/usr/bin/env bash
set -euo pipefail
ADDR="10.77.0.1/24"
IFACE="eth0"
if command -v nmcli >/dev/null 2>&1; then
  if nmcli -t -f NAME con show | grep -qx 'trafficlight-eth'; then
    nmcli con modify trafficlight-eth connection.interface-name "$IFACE" ipv4.method manual ipv4.addresses "$ADDR" ipv4.gateway '' ipv4.dns '' ipv6.method disabled connection.autoconnect yes
  else
    nmcli con add type ethernet ifname "$IFACE" con-name trafficlight-eth ipv4.method manual ipv4.addresses "$ADDR" ipv4.gateway '' ipv4.dns '' ipv6.method disabled connection.autoconnect yes
  fi
  nmcli con up trafficlight-eth
else
  echo "ERROR: nmcli not found. Configure $IFACE manually as $ADDR before running trafficlight."
  exit 1
fi
ip -br addr show "$IFACE"
