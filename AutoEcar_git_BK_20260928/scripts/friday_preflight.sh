#!/usr/bin/env bash
set -u
PASS=0; FAIL=0
ok(){ echo "[PASS] $*"; PASS=$((PASS+1)); }
bad(){ echo "[FAIL] $*"; FAIL=$((FAIL+1)); }
command -v python3 >/dev/null && ok "python3" || bad "python3 missing"
command -v mosquitto_sub >/dev/null && ok "mosquitto clients" || bad "mosquitto-clients missing"
ip -4 addr show eth0 | grep -q '10\.77\.0\.1/24' && ok "eth0 10.77.0.1/24" || bad "eth0 static IP"
systemctl is-active --quiet mosquitto && ok "mosquitto active" || bad "mosquitto inactive"
for s in S1 S2 S3 S4; do [[ -e "/dev/traffic-$s" ]] && ok "/dev/traffic-$s" || bad "/dev/traffic-$s missing"; done
systemctl is-enabled --quiet trafficlight && ok "trafficlight autostart enabled" || bad "trafficlight not enabled"
echo
ip -br addr
printf '\nPASS=%d FAIL=%d\n' "$PASS" "$FAIL"
echo "Next display network check: ./scripts/display_network_debug.sh"
[[ $FAIL -eq 0 ]]
