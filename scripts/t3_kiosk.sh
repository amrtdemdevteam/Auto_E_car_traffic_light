#!/usr/bin/env bash
# T3: open the web UI full screen on the Pi touch screen (no browser bars).
# First boot shows the setup wizard; after setup it shows the main map.
# Started by /etc/xdg/autostart/trafficlight-kiosk.desktop (installed by install.sh --t3).
set -u
APP="${APP:-/opt/trafficlight}"
CONF="${CONF:-/etc/trafficlight}"
PORT="$("$APP/.venv/bin/python" - "$CONF/settings.json" <<'PY' 2>/dev/null || echo 8080
import json, sys
try:
    print(int(json.load(open(sys.argv[1])).get("web", {}).get("port", 8080)))
except Exception:
    print(8080)
PY
)"
URL="http://localhost:${PORT}/"

# wait (max ~60 s) until the web service answers
for _ in $(seq 1 60); do
  if curl -fs -o /dev/null "${URL}api/me"; then break; fi
  sleep 1
done

# already open (double-clicked the desktop icon twice): nothing to do
if pgrep -f -- "--kiosk" >/dev/null 2>&1; then exit 0; fi

BROWSER="$(command -v chromium || command -v chromium-browser || true)"
[[ -n "$BROWSER" ]] || { echo "no chromium installed" >&2; exit 1; }

exec "$BROWSER" --kiosk --noerrdialogs --disable-infobars --no-first-run \
  --disable-session-crashed-bubble --disable-translate --check-for-update-interval=31536000 \
  --touch-events=enabled --overscroll-history-navigation=0 --password-store=basic \
  "$URL"
