"""Main loop of the T3 controller service."""
from __future__ import annotations

import signal
import time

from loguru import logger

from . import frames as F
from .config import validate
from .controller import IDENTIFY_S, T3Controller
from .display_link import DisplayLink
from .ports import PortProbe
from .sensors import SensorHub

_RUN = True


def _stop(*_):
    global _RUN
    _RUN = False


def _config_error_loop(cfg: dict, errors: list[str]) -> int:
    """Invalid config: never control traffic, show CONFIG ERROR on every display."""
    for e in errors:
        logger.error(f"T3 event=config_invalid {e}")
    link = DisplayLink(cfg)
    probe = PortProbe(int(cfg["sensor_defaults"].get("baudrate", 115200)))
    displays = sorted({int(d) for d in cfg.get("displays", {})} |
                      {int(l["display"]) for l in cfg.get("lanes", []) if isinstance(l.get("display"), int)})
    identify: dict[int, float] = {}
    next_state = 0.0
    try:
        while _RUN:
            now = time.monotonic()
            probe.update(now, busy=set())
            for d in sorted(set(displays) | set(identify)):
                if identify.get(d, 0.0) > now:   # "which display is this?" never green
                    link.command(d, F.TEST, f"B{d}", now)
                else:
                    link.command(d, F.CONFIG, "", now)
            link.tick(now)
            if now >= next_state:
                next_state = now + 0.5
                link.publish_state({"state": "CONFIG_ERROR", "errors": errors, "lanes": [], "queue": [],
                                    "sensors": [], "events": [], "junction_id": cfg.get("junction_id"),
                                    "config_version": cfg.get("_version"),
                                    "ports": probe.snapshot(now, {})})
            for cmd in link.pop_commands():
                if cmd.get("cmd") in ("apply_config", "restart"):
                    return 0
                if cmd.get("cmd") == "identify":
                    try:
                        identify[int(cmd.get("display"))] = now + IDENTIFY_S
                        link.publish_result(cmd, f"จอ B{int(cmd.get('display'))} แสดง TEST")
                    except (TypeError, ValueError):
                        link.publish_result(cmd, "ไม่รู้จักจอ")
            time.sleep(0.05)
    finally:
        link.close()
        probe.close()
    return 3


def _sim_command(cmd: dict, cfg: dict, hub: SensorHub, ctrl: T3Controller, now: float,
                 link: DisplayLink | None = None) -> str:
    """Admin test mode. Only the configured user may use it; the controller itself is untouched."""
    user = str(cmd.get("user", "?"))
    if user != cfg["sim"]["user"]:
        logger.warning(f"T3 event=sim_denied user={user}")
        return "โหมดจำลองใช้ได้เฉพาะ " + str(cfg["sim"]["user"])
    name = cmd.get("cmd")
    if name == "sim":
        on = bool(cmd.get("on"))
        res = hub.sim_set(on, now)
        ctrl._log(f"{user} {res}", "sim_on" if on else "sim_off", user=user)
        return res
    if name == "sim_display" and link is not None:
        on = bool(cmd.get("on"))
        res = link.virtual_set(on, now, float(cfg["sim"]["max_s"]))
        ctrl._log(f"{user} {res}", "sim_display_on" if on else "sim_display_off", user=user)
        return res
    if name == "sim_sensor":
        return hub.sim_sensor(str(cmd.get("sensor", "")), str(cmd.get("state", "")), now)
    if name == "sim_pulse":
        return hub.sim_pulse(str(cmd.get("sensor", "")), now)
    return "ไม่รู้จักคำสั่ง"


def run(cfg: dict) -> int:
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    logger.info(f"T3 event=service_start junction={cfg['junction_id']}")
    errors = validate(cfg)
    if errors:
        return _config_error_loop(cfg, errors)

    hub = SensorHub(cfg)
    probe = PortProbe(int(cfg["sensor_defaults"].get("baudrate", 115200)))
    link = DisplayLink(cfg)
    now = time.monotonic()
    ctrl = T3Controller(cfg, hub.sensors, link, now)
    period = 1.0 / max(1.0, float(cfg.get("loop_hz", 20)))
    next_state = 0.0
    slow_loops = 0
    rc = 0
    try:
        while _RUN:
            started = time.monotonic()
            events = hub.update(started)
            now = time.monotonic()
            for cmd in link.pop_commands():
                if str(cmd.get("cmd", "")).startswith("sim"):
                    result = _sim_command(cmd, cfg, hub, ctrl, now, link)
                else:
                    result = ctrl.command(cmd, now)
                link.publish_result(cmd, result)
            ctrl.tick(now, events)
            link.tick(now)
            if now >= next_state:
                next_state = now + 0.5
                assigned = hub.assigned(now)
                probe.update(now, busy=set(assigned))
                st = ctrl.status(now)
                st["ports"] = probe.snapshot(now, assigned)
                st["junction_id"] = cfg["junction_id"]
                st["junction_name"] = cfg.get("junction_name", "")
                st["config_version"] = cfg.get("_version")
                st["loop_slow_count"] = slow_loops
                st["sim"] = hub.sim_status(now)
                st["sim_display"] = link.virtual_status(now)
                link.publish_state(st)
            if ctrl.can_exit():
                logger.info("T3 event=service_exit_for_restart")
                break
            elapsed = time.monotonic() - started
            if elapsed > period * 2:
                slow_loops += 1
                logger.debug(f"T3 slow_loop elapsed={elapsed:.3f}s")
            if elapsed < period:
                time.sleep(period - elapsed)
    except Exception:  # noqa: BLE001
        logger.exception("T3 event=fatal_exception")
        rc = 1
    finally:
        link.close()
        hub.close()
        probe.close()
        logger.info("T3 event=service_stop")
    return rc
