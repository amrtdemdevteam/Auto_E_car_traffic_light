"""T3 sensor filtering.

FilteredSensor  vehicle / generic ToF sensor: debounce, gap hold, offline, recovery.
HandDetector    hand-hold state machine for special lanes (C3, C5).
SensorHub       owns the serial readers and the FilteredSensor objects.

Safety rule: an offline or stale sensor never produces a filtered clear.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from loguru import logger


@dataclass
class SensorEvent:
    sensor: str
    kind: str          # "rising" | "clear" | "offline" | "recovered"
    at: float
    edge_id: int = 0


class FilteredSensor:
    def __init__(self, sensor_id: str, params: dict):
        self.id = sensor_id
        self.min_cm = float(params["min_detect_cm"])
        self.max_cm = float(params["max_detect_cm"])
        self.min_strength = float(params["min_strength"])
        self.debounce_s = float(params["debounce_ms"]) / 1000.0
        self.gap_hold_s = float(params["gap_hold_s"])
        self.offline_timeout_s = float(params["offline_timeout_s"])
        self.recover_stable_s = float(params["recover_stable_s"])
        self.fresh_timeout_s = float(params.get("fresh_timeout_s", 0.5))

        self.online = False
        self.raw = False
        self.occupied = False
        self.distance_cm: int | None = None
        self.strength: int | None = None
        self.last_frame_at: float | None = None
        self.edge_id = 0
        self.last_rising_at: float | None = None
        self.last_clear_at: float | None = None
        self.offline_since: float | None = None

        self._raw_since: float | None = None
        self._last_raw_at: float | None = None
        self._recover_since: float | None = None
        self._events: list[SensorEvent] = []
        self._ever_online = False

    # ------------------------------------------------------------------ input
    def ingest(self, distance_cm: int, strength: int, now: float) -> None:
        # a gap in the frame stream restarts the recovery window
        if self.last_frame_at is not None and now - self.last_frame_at > self.fresh_timeout_s:
            self._recover_since = None
        self.last_frame_at = now
        self.distance_cm = distance_cm
        self.strength = strength
        raw = strength >= self.min_strength and self.min_cm <= distance_cm <= self.max_cm
        self.raw = raw

        if not self.online:
            if self._recover_since is None:
                self._recover_since = now
            if now - self._recover_since >= self.recover_stable_s:
                self.online = True
                self.offline_since = None
                self._reset_occupancy()
                kind = "recovered" if self._ever_online else "online"
                self._ever_online = True
                self._events.append(SensorEvent(self.id, kind, now))
                logger.info(f"T3 event=sensor_{kind} sensor={self.id}")
            else:
                return

        if raw:
            self._last_raw_at = now
            if self._raw_since is None:
                self._raw_since = now
            if not self.occupied and now - self._raw_since >= self.debounce_s:
                self.occupied = True
                self.edge_id += 1
                self.last_rising_at = now
                self._events.append(SensorEvent(self.id, "rising", now, self.edge_id))
                logger.info(f"T3 event=sensor_rising sensor={self.id} edge={self.edge_id} "
                            f"dist={distance_cm} strength={strength}")
        else:
            self._raw_since = None

    def tick(self, now: float) -> None:
        if self.online and (self.last_frame_at is None or now - self.last_frame_at > self.offline_timeout_s):
            self.online = False
            self.offline_since = now
            self._recover_since = None
            self._reset_occupancy()
            self._events.append(SensorEvent(self.id, "offline", now))
            logger.warning(f"T3 event=sensor_offline sensor={self.id}")
            return
        if not self.online or not self.occupied:
            return
        fresh = self.last_frame_at is not None and now - self.last_frame_at <= self.fresh_timeout_s
        if not fresh:
            return  # stale data is never evidence of clear
        # clear needs a fresh frame that shows "nothing" (raw False), never just missing frames
        if not self.raw and self._last_raw_at is not None and now - self._last_raw_at > self.gap_hold_s:
            self.occupied = False
            self.last_clear_at = now
            self._events.append(SensorEvent(self.id, "clear", now, self.edge_id))
            logger.info(f"T3 event=sensor_clear sensor={self.id} edge={self.edge_id}")

    def _reset_occupancy(self) -> None:
        self.occupied = False
        self.raw = False
        self._raw_since = None
        self._last_raw_at = None

    def pop_events(self) -> list[SensorEvent]:
        ev, self._events = self._events, []
        return ev

    def snapshot(self) -> dict:
        return {
            "id": self.id, "online": self.online, "raw": self.raw, "occupied": self.occupied,
            "distance_cm": self.distance_cm, "strength": self.strength,
        }


class HandDetector:
    """Hold-to-request for special lanes.

    phases: idle -> track (HOLD / HAND1 / HAND2) -> confirmed (HANDOK) -> rearm -> idle
    """

    def __init__(self, sensor: FilteredSensor, hand_cfg: dict):
        self.sensor = sensor
        self.hold_s = float(hand_cfg["hold_s"])
        self.grace_s = float(hand_cfg["grace_ms"]) / 1000.0
        self.confirm_show_s = float(hand_cfg["confirm_show_s"])
        self.rearm_clear_s = float(hand_cfg["rearm_clear_s"])
        self.phase = "idle"
        self._start: float | None = None
        self._last_seen: float | None = None
        self._confirm_until = 0.0
        self._last_logged_step = -1

    def reset(self) -> None:
        self.phase = "idle"
        self._start = None
        self._last_logged_step = -1

    def update(self, now: float, can_accept: bool) -> bool:
        """Advance the state machine. Returns True when a ticket must be created."""
        s = self.sensor
        if not s.online:
            self.reset()
            return False
        if s.raw:
            self._last_seen = now

        if self.phase == "idle":
            if s.raw and can_accept:
                self.phase = "track"
                self._start = now
                self._last_logged_step = -1
            return False

        if self.phase == "track":
            seen_recently = self._last_seen is not None and now - self._last_seen <= self.grace_s
            if not seen_recently:
                self.reset()
                return False
            if not can_accept:
                self.reset()
                return False
            held = now - self._start
            step = min(3, int(held))
            if step != self._last_logged_step:
                self._last_logged_step = step
                logger.info(f"T3 event=hand_progress sensor={s.id} step={step}")
            if held >= self.hold_s:
                self.phase = "confirmed"
                self._confirm_until = now + self.confirm_show_s
                return True
            return False

        if self.phase == "confirmed":
            if now >= self._confirm_until:
                self.phase = "rearm"
            return False

        if self.phase == "rearm":
            if self._last_seen is None or now - self._last_seen >= self.rearm_clear_s:
                self.reset()
            return False
        return False

    def display_frame(self, now: float) -> str | None:
        if self.phase == "track" and self._start is not None:
            held = now - self._start
            if held < 1.0:
                return "HOLD"
            if held < 2.0:
                return "HAND1"
            return "HAND2"
        if self.phase == "confirmed":
            return "HANDOK"
        return None


@dataclass
class _Port:
    path: str
    reader: object | None = None
    next_open: float = 0.0
    failed_logged: bool = False


class SensorHub:
    """Reads every configured sensor port and feeds the FilteredSensor objects."""

    def __init__(self, cfg: dict, reader_factory=None):
        from .config import sensor_params
        self.cfg = cfg
        self.sensors: dict[str, FilteredSensor] = {
            sid: FilteredSensor(sid, sensor_params(cfg, sid)) for sid in cfg["sensors"]
        }
        self.ports = {sid: _Port(v.get("port", "")) for sid, v in cfg["sensors"].items()}
        self._reopen_s = float(cfg["sensor_defaults"].get("reopen_interval_s", 2.0))
        self._baud = int(cfg["sensor_defaults"].get("baudrate", 115200))
        self._reader_factory = reader_factory

    def _open(self, sid: str, now: float) -> None:
        port = self.ports[sid]
        if port.reader is not None or now < port.next_open or not port.path:
            return
        port.next_open = now + self._reopen_s
        try:
            if self._reader_factory is not None:
                port.reader = self._reader_factory(port.path, self._baud)
            else:
                from ..sensor.tfmini import TFMiniReader
                port.reader = TFMiniReader(port.path, self._baud, timeout=0)
            port.failed_logged = False
            logger.info(f"T3 sensor={sid} port_open {port.path}")
        except Exception as exc:  # noqa: BLE001 - keep running, sensor stays offline
            msg = f"T3 sensor={sid} port_open_failed port={port.path} error={exc}"
            if port.failed_logged:
                logger.debug(msg)
            else:
                port.failed_logged = True
                logger.warning(msg)

    def update(self, now: float) -> list[SensorEvent]:
        events: list[SensorEvent] = []
        for sid, sensor in self.sensors.items():
            self._open(sid, now)
            port = self.ports[sid]
            if port.reader is not None:
                try:
                    for frame in port.reader.read_available():
                        sensor.ingest(frame.distance_cm, frame.strength, now)
                except Exception as exc:  # noqa: BLE001
                    logger.error(f"T3 sensor={sid} read_error {exc}; reopening")
                    try:
                        port.reader.close()
                    except Exception:  # noqa: BLE001
                        pass
                    port.reader = None
                    port.next_open = now + self._reopen_s
            sensor.tick(now)
            events.extend(sensor.pop_events())
        return events

    def assigned(self, now: float) -> dict[str, dict]:
        """real port path -> live values of the sensor using it (for the web UI)."""
        import os
        out = {}
        for sid, port in self.ports.items():
            if not port.path:
                continue
            s = self.sensors[sid]
            out[os.path.realpath(port.path)] = {
                "id": sid, "distance_cm": s.distance_cm, "strength": s.strength,
                "age_s": None if s.last_frame_at is None else round(now - s.last_frame_at, 1),
            }
        return out

    def close(self) -> None:
        for port in self.ports.values():
            if port.reader is not None:
                try:
                    port.reader.close()
                except Exception:  # noqa: BLE001
                    pass
                port.reader = None
