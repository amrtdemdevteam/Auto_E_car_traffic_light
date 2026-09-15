from __future__ import annotations
import argparse, signal, time
from pathlib import Path
from loguru import logger
from .config import load_config
from .logging.log_manager import setup_logging
from .sensor.sensor_manager import SensorManager
from .traffic.pair_detector import RedEntryDetector
from .traffic.state_machine import StateMachine
from .display.display_manager import DisplayManager

RUN = True
CORRIDOR_SENSOR_NAMES = ("S1", "S2", "S3", "S4")

def _stop(*_):
    global RUN
    RUN = False

def red_exit_sensor_active(s1, now: float, fresh_timeout_s: float) -> bool:
    last_frame = s1.last_valid_frame
    age = None if last_frame is None else now - last_frame
    fresh = s1.online and age is not None and 0 <= age <= fresh_timeout_s
    return (not fresh) or s1.occupied


def corridor_sensor_fresh(sensor, now: float, fresh_timeout_s: float) -> bool:
    last_frame = sensor.last_valid_frame
    age = None if last_frame is None else now - last_frame
    return sensor.online and age is not None and 0 <= age <= fresh_timeout_s


def corridor_release_blocked(sensors: dict, now: float, fresh_timeout_s: float) -> bool:
    """Fail-safe block when any corridor sensor is not fresh and online."""
    return any(
        not corridor_sensor_fresh(sensors[name], now, fresh_timeout_s)
        for name in CORRIDOR_SENSOR_NAMES
    )

def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="/etc/trafficlight/settings.json")
    args = parser.parse_args(argv)
    cfg = load_config(args.config)
    setup_logging(cfg)
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    logger.info("SYSTEM START")
    logger.info(f"junction={cfg['junction_id']} type={cfg['junction_type']}")
    if cfg.get("junction_type") != "normal":
        logger.error("Only junction_type=normal is enabled in V1")
        return 2

    sensors = SensorManager(cfg)
    red_entry = RedEntryDetector()
    sm = StateMachine(cfg["timing"])
    red_exit_fresh_timeout = float(cfg["timing"].get("red_exit_sensor_fresh_timeout_s", 0.5))
    display = DisplayManager(cfg)
    period = 1.0 / max(1, float(cfg.get("loop_hz", 20)))
    try:
        while RUN:
            started = time.monotonic()
            snaps = sensors.update()
            control_now = time.monotonic()
            r = red_entry.update(snaps, control_now)
            red_exit_active = red_exit_sensor_active(snaps["S1"], control_now, red_exit_fresh_timeout)
            corridor_occupied = any(snaps[name].occupied for name in CORRIDOR_SENSOR_NAMES)
            corridor_blocked = corridor_release_blocked(
                snaps, control_now, red_exit_fresh_timeout
            )
            state = sm.update(
                False,
                r.triggered,
                False,
                control_now,
                red_exit_sensor_active=red_exit_active,
                red_exit_sensor_occupied=snaps["S1"].occupied,
                corridor_occupied=corridor_occupied,
                corridor_activity=r.activity,
                corridor_release_blocked=corridor_blocked,
            )
            faults = sorted(name for name, s in snaps.items() if not s.online)
            display.publish(state.value, faults)
            elapsed = time.monotonic() - started
            if elapsed < period:
                time.sleep(period - elapsed)
    except Exception:
        logger.exception("SYSTEM fatal_exception")
        return 1
    finally:
        display.close()
        sensors.close()
        logger.info("SYSTEM STOP")
    return 0
