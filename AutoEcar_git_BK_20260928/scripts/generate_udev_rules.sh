#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: run with sudo: sudo $0"
  exit 1
fi

OUT="/etc/udev/rules.d/99-trafficlight-sensors.rules"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
: > "$TMP"

declare -A USED_DEVS=()
declare -A USED_KEYS=()

get_prop(){
  local props="$1"
  local key="$2"
  grep -m1 "^${key}=" <<<"$props" | cut -d= -f2- || true
}

print_device_info(){
  local dev="$1"
  local props="$2"
  printf '  %s\n' "$dev"
  for key in ID_VENDOR ID_MODEL ID_VENDOR_ID ID_MODEL_ID ID_SERIAL ID_SERIAL_SHORT ID_PATH; do
    printf '    %-15s %s\n' "$key" "$(get_prop "$props" "$key")"
  done
}

count_value(){
  local key="$1"
  local value="$2"
  local count=0
  local dev props current
  for dev in "${DEVS[@]}"; do
    props="$(udevadm info --query=property --name="$dev" 2>/dev/null || true)"
    current="$(get_prop "$props" "$key")"
    [[ -n "$current" && "$current" == "$value" ]] && count=$((count+1))
  done
  printf '%s\n' "$count"
}

echo "E-Car Traffic Light USB-RS485 mapping wizard"
echo "Maps S1..S4 to stable /dev/traffic-S1 .. /dev/traffic-S4 names."
echo "Expected adapters: Waveshare Industrial USB to RS485, SKU 17286 / USB TO RS485."
echo "Hardware: FTDI FT232RNL + SP485EEN. Linux/Raspberry Pi support is expected."
echo "Do not rely on /dev/ttyUSB numbering; it is not stable."
echo "Unique FTDI ID_SERIAL_SHORT mapping is preferred. If absent/duplicated, this wizard falls back to physical USB ID_PATH."
echo "For PATH-based mappings, keep each adapter in its FINAL USB-hub port."

for S in S1 S2 S3 S4; do
  echo
  echo "=== $S ==="
  echo "Connect/identify the USB-RS485 adapter for $S, then press Enter."
  read -r
  mapfile -t DEVS < <(find /dev -maxdepth 1 \( -name 'ttyUSB*' -o -name 'ttyACM*' \) -printf '%p\n' | sort)
  if [[ ${#DEVS[@]} -eq 0 ]]; then
    echo "ERROR: no ttyUSB/ttyACM adapter detected."
    exit 1
  fi
  printf 'Detected USB serial adapters:\n'
  for detected in "${DEVS[@]}"; do
    DETECTED_PROPS="$(udevadm info --query=property --name="$detected" 2>/dev/null || true)"
    print_device_info "$detected" "$DETECTED_PROPS"
  done
  read -r -p "Device path for $S (example /dev/ttyUSB0): " DEV
  [[ -e "$DEV" ]] || { echo "ERROR: not found: $DEV"; exit 1; }
  if [[ -n "${USED_DEVS[$DEV]:-}" ]]; then
    echo "ERROR: $DEV was already assigned to ${USED_DEVS[$DEV]}. Choose a different adapter for $S."
    exit 1
  fi

  PROPS="$(udevadm info --query=property --name="$DEV")"
  print_device_info "$DEV" "$PROPS"
  IDPATH="$(grep '^ID_PATH=' <<<"$PROPS" | cut -d= -f2- || true)"
  SERIAL="$(grep '^ID_SERIAL_SHORT=' <<<"$PROPS" | cut -d= -f2- || true)"

  RULE_KEY=""
  RULE_VALUE=""
  MAPPING_METHOD=""
  if [[ -n "$SERIAL" && "$(count_value ID_SERIAL_SHORT "$SERIAL")" == "1" ]]; then
    echo "SUBSYSTEM==\"tty\", ATTRS{serial}==\"$SERIAL\", SYMLINK+=\"traffic-$S\", GROUP=\"dialout\", MODE=\"0660\"" >> "$TMP"
    RULE_KEY="SERIAL_BASED"
    RULE_VALUE="$SERIAL"
    MAPPING_METHOD="serial number"
  elif [[ -n "$IDPATH" ]]; then
    if [[ -n "$SERIAL" ]]; then
      echo "WARNING: ID_SERIAL_SHORT '$SERIAL' is duplicated or not unique in the currently detected adapters; using ID_PATH."
    else
      echo "WARNING: ID_SERIAL_SHORT is absent; using ID_PATH."
    fi
    echo "SUBSYSTEM==\"tty\", ENV{ID_PATH}==\"$IDPATH\", SYMLINK+=\"traffic-$S\", GROUP=\"dialout\", MODE=\"0660\"" >> "$TMP"
    RULE_KEY="PATH_BASED"
    RULE_VALUE="$IDPATH"
    MAPPING_METHOD="physical USB path"
  else
    echo "ERROR: cannot uniquely identify $DEV. Use a USB adapter/hub path that exposes ID_PATH."
    exit 1
  fi

  rule_identity="$RULE_KEY:$RULE_VALUE"
  if [[ -n "${USED_KEYS[$rule_identity]:-}" ]]; then
    echo "ERROR: $rule_identity was already assigned to ${USED_KEYS[$rule_identity]}. Duplicate persistent mapping refused."
    exit 1
  fi
  USED_DEVS[$DEV]="$S"
  USED_KEYS[$rule_identity]="$S"
  echo "$S -> $MAPPING_METHOD $RULE_VALUE ($RULE_KEY)"
done

cp "$TMP" "$OUT"
chmod 644 "$OUT"
udevadm control --reload-rules
udevadm trigger --subsystem-match=tty
sleep 1

echo
echo "Installed rules: $OUT"
cat "$OUT"
echo

MISSING=0
for S in S1 S2 S3 S4; do
  if [[ -e "/dev/traffic-$S" ]]; then
    echo "[PASS] /dev/traffic-$S -> $(readlink -f "/dev/traffic-$S")"
  else
    echo "[WAIT] /dev/traffic-$S is not present yet. Replug that adapter in its mapped USB port."
    MISSING=1
  fi
done

if [[ $MISSING -ne 0 ]]; then
  echo
  echo "Rules are installed, but one or more adapters need to be replugged."
  echo "After all four /dev/traffic-S* links exist, rerun this command; you may select the same devices."
  echo "The trafficlight service remains disabled until all four mappings verify."
  exit 2
fi

systemctl daemon-reload
systemctl enable trafficlight >/dev/null
systemctl restart trafficlight

echo
echo "[PASS] All four sensor mappings verified."
echo "[PASS] trafficlight.service enabled for autostart and started now."
echo "Live log: sudo journalctl -u trafficlight -f"
