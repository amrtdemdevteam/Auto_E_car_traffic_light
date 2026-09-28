#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PY=python3
if [[ -x /opt/trafficlight/.venv/bin/python ]]; then
  PY=/opt/trafficlight/.venv/bin/python
elif [[ -x "$ROOT/.venv/bin/python" ]]; then
  PY="$ROOT/.venv/bin/python"
fi

echo '== Python syntax =='
"$PY" -m compileall -q raspberry_pi tests
echo 'PASS'

echo '== Unit tests =='
if "$PY" -c 'import pytest, loguru, serial, paho.mqtt.client' >/dev/null 2>&1; then
  PYTHONPATH="$ROOT/raspberry_pi" "$PY" -m pytest -q tests
else
  echo "SKIP: dependencies are not installed yet. This is normal before sudo ./install.sh."
fi

echo '== JSON config =='
"$PY" -m json.tool config/settings.example.json >/dev/null
echo 'PASS'

echo '== Shell syntax =='
for f in install.sh scripts/*.sh; do bash -n "$f"; done
echo 'PASS'

echo 'SELF TEST PASS'
