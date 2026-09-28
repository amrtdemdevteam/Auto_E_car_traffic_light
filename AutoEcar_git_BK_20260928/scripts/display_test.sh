#!/usr/bin/env bash
set -euo pipefail
BROKER="${BROKER:-10.77.0.1}"
TOPIC="factory/trafficlight/junction/1/display"
pub(){ mosquitto_pub -h "$BROKER" -t "$TOPIC" -q 1 -r -m "$1"; sleep "${2:-2}"; }
echo "GO 3s"; pub '{"junction":1,"state":"idle","text":"GO","color":"green","faults":[],"fault_text":""}' 3
echo "CAUTION 3s"; pub '{"junction":1,"state":"yellow","text":"CAUTION","color":"yellow","faults":[],"fault_text":""}' 3
echo "STOP 3s"; pub '{"junction":1,"state":"red","text":"STOP","color":"red","faults":[],"fault_text":""}' 3
echo "Fault overlay 4s"; pub '{"junction":1,"state":"idle","text":"GO","color":"green","faults":["S2"],"fault_text":"ERR:S2"}' 4
echo "Return GO"; pub '{"junction":1,"state":"idle","text":"GO","color":"green","faults":[],"fault_text":""}' 1
