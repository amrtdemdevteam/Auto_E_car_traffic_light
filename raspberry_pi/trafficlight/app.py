from __future__ import annotations
import argparse, signal, time
from pathlib import Path
from loguru import logger
from .config import load_config
from .logging.log_manager import setup_logging
from .sensor.sensor_manager import SensorManager
from .traffic.pair_detector import DirectionalPairDetector
from .traffic.state_machine import StateMachine
from .display.display_manager import DisplayManager

RUN = True

def _stop(*_):
    global RUN
    RUN = False

def red_exit_sensor_active(s1, now: float, fresh_timeout_s: float) -> bool:
    last_frame = s1.last_valid_frame
    age = None if last_frame is None else now - last_frame
    fresh = s1.online and age is not None and 0 <= age <= fresh_timeout_s
    return (not fresh) or s1.occupied

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
    yellow = DirectionalPairDetector(*cfg["direction"]["yellow_order"], cfg["direction"]["pair_window_s"], "YELLOW")
    red = DirectionalPairDetector(*cfg["direction"]["red_order"], cfg["direction"]["pair_window_s"], "RED")
    sm = StateMachine(cfg["timing"])
    red_exit_fresh_timeout = float(cfg["timing"].get("red_exit_sensor_fresh_timeout_s", 0.5))
    display = DisplayManager(cfg)
    period = 1.0 / max(1, float(cfg.get("loop_hz", 20)))
    try:
        while RUN:
            started = time.monotonic()
            snaps = sensors.update()
            control_now = time.monotonic()
            y = yellow.update(snaps, control_now)
            r = red.update(snaps, control_now)
            red_exit_active = red_exit_sensor_active(snaps["S1"], control_now, red_exit_fresh_timeout)
            state = sm.update(y.triggered, r.triggered, y.active, control_now, red_exit_active)
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
