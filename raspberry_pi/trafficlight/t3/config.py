"""T3 configuration: defaults, merging and validation.

Every number used by the T3 controller lives here or in the junction's
settings.json; nothing is hard-coded elsewhere.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

from . import frames

# A lane is "auto" or "manual". Manual lanes have a mode:
#   "vehicle"  sensor sees the vehicle, green until the lane is clear
#   "hand"     driver holds a hand in front of a side ToF, fixed green time
# The older type "special" (= manual + hand) is still accepted.
LANE_TYPES = ("auto", "manual", "special")
MANUAL_MODES = ("vehicle", "hand")

# Per-lane parameters. The value in `timing` / `hand` is the default for the
# lane type; a lane may override any of them in lane["params"].
LANE_PARAM_KEYS = {
    "auto": ("auto_clear_s", "auto_ticket_expiry_s"),
    "manual": ("manual_clear_s",),
    "special": ("special_green_s", "hold_s", "grace_ms", "confirm_show_s", "rearm_clear_s",
                "max_pending_per_lane"),
}
# Filter parameters that may be set per sensor (sensors[<id>][key]).
SENSOR_PARAM_KEYS = ("min_detect_cm", "max_detect_cm", "min_strength", "debounce_ms", "gap_hold_s")

DEFAULTS: dict = {
    "junction_id": "T3",
    "junction_name": "",
    "junction_type": "t3",
    "loop_hz": 20,
    "mqtt": {
        "broker": "10.77.0.1",
        "port": 1883,
        "keepalive_s": 30,
        "base_topic": "factory/trafficlight",
    },
    "sensor_defaults": {
        "baudrate": 115200,
        "min_detect_cm": 30,
        "max_detect_cm": 250,
        "min_strength": 100,
        "debounce_ms": 200,
        "gap_hold_s": 1.2,
        "offline_timeout_s": 2.0,
        "recover_stable_s": 1.0,
        "fresh_timeout_s": 0.5,
        "reopen_interval_s": 2.0,
    },
    # sensor id -> {"port": "...", optional per-sensor overrides of sensor_defaults}
    "sensors": {},
    "hand": {
        "hold_s": 3.0,
        "grace_ms": 300,
        "confirm_show_s": 1.0,
        "rearm_clear_s": 0.5,
        "max_pending_per_lane": 1,
    },
    "timing": {
        "manual_clear_s": 3.0,
        "auto_clear_s": 4.0,
        "special_green_s": 3.0,
        "auto_ticket_expiry_s": 7.0,
        "switch_all_red_s": 1.0,
        "display_ack_timeout_s": 2.0,
        "display_link_timeout_s": 5.0,
        "display_fault_timeout_s": 6.0,
        "command_refresh_s": 1.0,
        "fault_clear_s": 12.0,
        "startup_min_s": 3.0,
    },
    "priority": {"auto_first": True},
    # list of lanes, see settings.t3.example.json
    "lanes": [],
    # display id (string) -> {"ip": "10.77.0.3x"}
    "display_ip_base": 30,   # display Bn = 10.77.0.(base + n); used by the web UI to suggest the IP, must match DISPLAY_IP_BASE in the firmware
    "displays": {},
    "frames": {"enabled_reserve": []},
    "ota": {"port": 65280, "password": "change-me"},
    # first-run wizard: burn pre-built display firmware from the Pi (esptool), one display at a time
    "setup": {
        "display_count": 5,
        "firmware_dir": "firmware/t3",          # <firmware_dir>/display<N>/<file>; relative to the install root
        "esptool": ["python3", "-m", "esptool"],
        "chip": "esp32s3",
        "baud": 460800,
        "flash_args": ["--flash_mode", "keep", "--flash_freq", "keep", "--flash_size", "keep"],
        "files": [["0x0", "bootloader.bin"], ["0x8000", "partitions.bin"],
                  ["0xe000", "boot_app0.bin"], ["0x10000", "firmware.bin"]],
        "timeout_s": 240,
        "log_lines": 30,
    },
    "web": {"bind": "0.0.0.0", "port": 8080, "session_hours": 8, "flow_gap_s": 5, "flow_save_s": 30},
    "log": {
        "directory": "/var/log/trafficlight",
        "rotation": "100 MB",
        "retention": "7 days",
        "level": "INFO",
        "sensor_sample_interval_s": 1.0,
    },
}


def _merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def with_defaults(raw: dict) -> dict:
    return _merge(DEFAULTS, raw)


def load(path: str | Path) -> dict:
    with Path(path).open("r", encoding="utf-8") as f:
        return with_defaults(json.load(f))


def sensor_params(cfg: dict, sensor_id: str) -> dict:
    """Effective parameters of one sensor: defaults + its own overrides."""
    params = dict(cfg["sensor_defaults"])
    params.update({k: v for k, v in cfg["sensors"].get(sensor_id, {}).items() if k != "port"})
    return params


def lane_kind(lane: dict) -> str:
    """Internal kind used by the controller: auto / manual / special."""
    if lane.get("type") == "special":
        return "special"
    if lane.get("type") == "manual" and lane.get("mode") == "hand":
        return "special"
    return lane.get("type", "")


def lane_params(cfg: dict, lane: dict) -> dict:
    """Effective per-lane parameters: type defaults + the lane's overrides."""
    out = {k: cfg["timing"][k] for k in ("auto_clear_s", "auto_ticket_expiry_s",
                                         "manual_clear_s", "special_green_s")}
    out.update(cfg["hand"])
    out.update(lane.get("params") or {})
    return out


def lane_sensors(lane: dict) -> list[str]:
    if lane.get("type") == "auto":
        return [s for s in (lane.get("near_sensor"), lane.get("far_sensor")) if s]
    return [lane["sensor"]] if lane.get("sensor") else []


def _num(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def validate(cfg: dict) -> list[str]:
    """Return a list of human readable (Thai) problems. Empty list = OK."""
    errors: list[str] = []
    t = cfg.get("timing", {})
    for key in (
        "manual_clear_s", "auto_clear_s", "special_green_s", "auto_ticket_expiry_s",
        "switch_all_red_s", "display_ack_timeout_s", "display_link_timeout_s",
        "display_fault_timeout_s",
        "command_refresh_s", "fault_clear_s", "startup_min_s",
    ):
        if not _num(t.get(key)) or t.get(key) <= 0:
            errors.append(f"timing.{key} ต้องเป็นตัวเลขมากกว่า 0")
    if _num(t.get("switch_all_red_s")) and t["switch_all_red_s"] < 0.5:
        errors.append("ช่วงสลับเลนต้องไม่น้อยกว่า 0.5 s")
    if _num(t.get("command_refresh_s")) and _num(t.get("display_link_timeout_s")):
        if t["command_refresh_s"] * 2 > t["display_link_timeout_s"]:
            errors.append("ส่งคำสั่งซ้ำถี่ไม่พอ: command_refresh_s × 2 ต้องไม่เกิน display_link_timeout_s")
    if _num(t.get("display_fault_timeout_s")) and _num(t.get("display_link_timeout_s")):
        if t["display_fault_timeout_s"] < t["display_link_timeout_s"] + 1.0:
            errors.append("เวลาเผื่อจอเสียต้องไม่น้อยกว่า อายุคำสั่งจอ + 1 s "
                          "(จอต้องเลิกเขียวเองแน่นอนก่อนเปิดเลนอื่น)")

    sd = cfg.get("sensor_defaults", {})
    for key in ("min_detect_cm", "max_detect_cm", "min_strength", "debounce_ms",
                "gap_hold_s", "offline_timeout_s", "recover_stable_s", "fresh_timeout_s"):
        if not _num(sd.get(key)) or sd.get(key) < 0:
            errors.append(f"sensor_defaults.{key} ต้องเป็นตัวเลขไม่ติดลบ")

    if _num(t.get("fault_clear_s")) and _num(t.get("auto_clear_s")) and _num(sd.get("gap_hold_s")):
        if t["fault_clear_s"] < t["auto_clear_s"] + sd["gap_hold_s"]:
            errors.append("เวลาเผื่อเคลียร์ต้องไม่น้อยกว่า เคลียร์ Auto (ค่าเริ่มต้น) + gap hold")

    h = cfg.get("hand", {})
    if not _num(h.get("grace_ms")) or not (100 <= h["grace_ms"] <= 1000):
        errors.append("อนุโลมมือหลุดต้องอยู่ระหว่าง 100–1000 ms")
    for key in ("hold_s", "confirm_show_s", "rearm_clear_s"):
        if not _num(h.get(key)) or h.get(key) <= 0:
            errors.append(f"hand.{key} ต้องเป็นตัวเลขมากกว่า 0")
    if not isinstance(h.get("max_pending_per_lane"), int) or h["max_pending_per_lane"] < 1:
        errors.append("hand.max_pending_per_lane ต้องเป็นจำนวนเต็มอย่างน้อย 1")

    lanes = cfg.get("lanes", [])
    if not lanes:
        errors.append("ยังไม่มีเลน")
    seen_ids, seen_displays, seen_sensors = set(), set(), set()
    auto_count = 0
    for lane in lanes:
        lid = lane.get("id")
        name = f"เลน {lid}"
        if not isinstance(lid, int):
            errors.append(f"{name}: id ต้องเป็นจำนวนเต็ม")
        if lid in seen_ids:
            errors.append(f"{name}: id ซ้ำ")
        seen_ids.add(lid)
        ltype = lane.get("type")
        if ltype not in LANE_TYPES:
            errors.append(f"{name}: ประเภทต้องเป็น Auto หรือ Manual")
            continue
        if ltype == "manual" and lane.get("mode", "vehicle") not in MANUAL_MODES:
            errors.append(f"{name}: Manual ต้องเลือกแบบ ตรวจรถ หรือ ยื่นมือ")
        kind = lane_kind(lane)
        params = lane.get("params") or {}
        if not isinstance(params, dict):
            errors.append(f"{name}: params ต้องเป็น object")
            params = {}
        for key, value in params.items():
            if key not in LANE_PARAM_KEYS[kind]:
                errors.append(f"{name}: ค่า {key} ใช้กับเลนประเภทนี้ไม่ได้")
            elif not _num(value) or value <= 0:
                errors.append(f"{name}: {key} ต้องเป็นตัวเลขมากกว่า 0")
        if kind == "special":
            lp = lane_params(cfg, lane) if "timing" in cfg and "hand" in cfg else {}
            if _num(lp.get("grace_ms")) and not (100 <= lp["grace_ms"] <= 1000):
                errors.append(f"{name}: อนุโลมมือหลุดต้องอยู่ระหว่าง 100–1000 ms")
            if "max_pending_per_lane" in params and not isinstance(params["max_pending_per_lane"], int):
                errors.append(f"{name}: จำนวนตั๋วค้างต้องเป็นจำนวนเต็ม")
        if kind == "auto" and _num(t.get("fault_clear_s")) and _num(sd.get("gap_hold_s")):
            clear = params.get("auto_clear_s", t.get("auto_clear_s"))
            if _num(clear) and t["fault_clear_s"] < clear + sd["gap_hold_s"]:
                errors.append(f"{name}: เวลาเผื่อเคลียร์ (ค่ารวม) ต้องไม่น้อยกว่า เคลียร์ Auto ของเลนนี้ + gap hold")
        if ltype == "auto":
            auto_count += 1
            if not lane.get("near_sensor") or not lane.get("far_sensor"):
                errors.append(f"{name}: เลน Auto ต้องมีเซนเซอร์ใกล้และไกล")
        elif not lane.get("sensor"):
            errors.append(f"{name}: ต้องเลือกเซนเซอร์")
        for sid in lane_sensors(lane):
            for key in SENSOR_PARAM_KEYS:
                v = cfg.get("sensors", {}).get(sid, {}).get(key)
                if v is not None and (not _num(v) or v < 0):
                    errors.append(f"{name}: {sid}.{key} ต้องเป็นตัวเลขไม่ติดลบ")
            sp = {**sd, **{k: v for k, v in cfg.get("sensors", {}).get(sid, {}).items() if k in SENSOR_PARAM_KEYS}}
            if _num(sp.get("min_detect_cm")) and _num(sp.get("max_detect_cm")) and sp["min_detect_cm"] >= sp["max_detect_cm"]:
                errors.append(f"{name}: {sid} ระยะใกล้สุดต้องน้อยกว่าระยะไกลสุด")
            if sid in seen_sensors:
                errors.append(f"{name}: เซนเซอร์ {sid} ถูกใช้ซ้ำ")
            seen_sensors.add(sid)
            port = cfg.get("sensors", {}).get(sid, {}).get("port")
            if not port:
                errors.append(f"{name}: เซนเซอร์ {sid} ยังไม่ได้เลือกพอร์ต")
        disp = lane.get("display")
        if not isinstance(disp, int) or not (1 <= disp <= 7):
            errors.append(f"{name}: จอต้องเป็นหมายเลข 1–7")
        elif disp in seen_displays:
            errors.append(f"{name}: จอ B{disp} ถูกใช้ซ้ำ")
        seen_displays.add(disp)
        if lane.get("green_frame", frames.GO) not in frames.LANE_GREEN_CHOICES:
            errors.append(f"{name}: ภาพไฟเขียวต้องเป็น GO / LEFT / RIGHT")
        if not _num(lane.get("priority", 0)):
            errors.append(f"{name}: priority ต้องเป็นตัวเลข")
    if auto_count > 1:
        errors.append("มีเลน Auto ได้ไม่เกินหนึ่งเลน")

    ports = [v.get("port") for v in cfg.get("sensors", {}).values() if v.get("port")]
    if len(ports) != len(set(ports)):
        errors.append("มีเซนเซอร์ใช้พอร์ตเดียวกัน")
    return errors
