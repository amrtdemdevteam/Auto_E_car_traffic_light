#!/usr/bin/env bash
set -euo pipefail
if systemctl list-unit-files | grep -q '^vncserver-x11-serviced.service'; then
  sudo systemctl enable --now vncserver-x11-serviced.service
  systemctl --no-pager --full status vncserver-x11-serviced.service || true
  echo "VNC service enabled. If no graphical desktop is installed, VNC service mode may still not provide a usable desktop session."
elif command -v raspi-config >/dev/null 2>&1; then
  sudo raspi-config nonint do_vnc 0
  echo "VNC enabled through raspi-config."
else
  echo "No supported VNC service found. Traffic controller itself does not require VNC."
  exit 1
fi
