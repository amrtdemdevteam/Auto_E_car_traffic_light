from __future__ import annotations
import time
from loguru import logger
from .tfmini import TFMiniReader
from .sensor import SensorState

class SensorManager:
    def __init__(self, cfg: dict):
        scfg = cfg["sensor"]
        self.scfg = scfg
        self.ports = dict(scfg["ports"])
        self.states = {
            name: SensorState(
                name,
                scfg["min_detect_cm"],
                scfg["max_detect_cm"],
                scfg["min_strength"],
                scfg["debounce_ms"],
                scfg["gap_hold_s"],
                scfg["offline_timeout_s"],
                scfg["recover_stable_s"],
            )
            for name in ("S1", "S2", "S3", "S4")
        }
        self.readers: dict[str, TFMiniReader] = {}
        self._next_open_attempt = {name: 0.0 for name in self.states}
        self._prev_online = {name: None for name in self.states}
        self._last_sample_log = 0.0
        self._sample_interval = float(cfg["log"].get("sensor_sample_interval_s", 1.0))
        self._reopen_s = float(scfg.get("reopen_interval_s", 2.0))
        self._last_frame = {name: None for name in self.states}

    def _close_reader(self, name: str):
        reader = self.readers.pop(name, None)
        if reader:
            try:
                reader.close()
            except Exception:
                pass

    def _ensure_reader(self, name: str, now: float):
        if name in self.readers or now < self._next_open_attempt[name]:
            return
        self._next_open_attempt[name] = now + self._reopen_s
        port = self.ports[name]
        try:
            self.readers[name] = TFMiniReader(port, int(self.scfg["baudrate"]))
            logger.info(f"SENSOR {name} port_open {port}")
        except Exception as e:
            logger.warning(f"SENSOR {name} port_open_failed port={port} error={e}")

    def close(self):
        for name in list(self.readers):
            self._close_reader(name)

    def update(self):
        now = time.monotonic()
        for name, state in self.states.items():
            self._ensure_reader(name, now)
            reader = self.readers.get(name)
            if reader:
                try:
                    for frame in reader.read_available():
                        self._last_frame[name] = frame
                        state.ingest(frame.distance_cm, frame.strength, now)
                except Exception as e:
                    logger.error(f"SENSOR {name} read_error {e}; will reopen")
                    self._close_reader(name)
                    self._next_open_attempt[name] = now + self._reopen_s

            snap = state.tick(now)
            prev = self._prev_online[name]
            if prev is None:
                if not snap.online:
                    logger.warning(f"SENSOR {name} OFFLINE at startup")
            elif snap.online != prev:
                logger.warning(f"SENSOR {name} {'RECOVERED' if snap.online else 'OFFLINE'}")
            self._prev_online[name] = snap.online

        if now - self._last_sample_log >= self._sample_interval:
            self._last_sample_log = now
            for s in self.states.values():
                snap = s.s
                logger.debug(
                    f"SENSOR {snap.name} dist={snap.distance_cm} strength={snap.strength} "
                    f"raw={snap.raw_detected} occupied={snap.occupied} online={snap.online} "
                    f"frame={getattr(self._last_frame[snap.name], 'raw_hex', None)}"
                )
        return {name: state.s for name, state in self.states.items()}
