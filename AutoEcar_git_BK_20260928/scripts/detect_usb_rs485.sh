#!/usr/bin/env bash
set -euo pipefail
for dev in /dev/ttyUSB* /dev/ttyACM*; do
  [[ -e "$dev" ]] || continue
  echo "==== $dev ===="
  udevadm info --query=property --name="$dev" | grep -E 'ID_VENDOR_ID=|ID_MODEL_ID=|ID_SERIAL=|ID_SERIAL_SHORT=' || true
done
