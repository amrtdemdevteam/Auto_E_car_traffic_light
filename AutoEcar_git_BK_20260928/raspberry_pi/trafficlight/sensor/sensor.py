from __future__ import annotations
from dataclasses import dataclass
import time
from loguru import logger


@dataclass
class SensorSnapshot:
    name: str
    distance_cm: int | None = None
    strength: int | None = None
    raw_detected: bool = False
    occupied: bool = False
    online: bool = False
    last_valid_frame: float | None = None
    first_detect_at: float | None = None
    last_detect_at: float | None = None
    rising_edge_at: float | None = None
    falling_edge_at: float | None = None


class SensorState:
    def __init__(
        self,
        name: str,
        min_detect_cm: int,
        max_detect_cm: int,
        min_strength: int,
        debounce_ms: int,
        gap_hold_s: float,
        offline_timeout_s: float,
        recover_stable_s: float,
    ):
        self.s = SensorSnapshot(name=name)

        self.min_detect_cm = min_detect_cm
        self.max_detect_cm = max_detect_cm
        self.min_strength = min_strength

        self.debounce_s = debounce_ms / 1000.0
        self.gap_hold_s = gap_hold_s
        self.offline_timeout_s = offline_timeout_s
        self.recover_stable_s = recover_stable_s

        self._raw_since: float | None = None
        self._recover_since: float | None = None
        self._last_raw: bool | None = None

    def ingest(self, distance_cm: int, strength: int, now: float | None = None):
        now = now if now is not None else time.monotonic()

        self.s.distance_cm = distance_cm
        self.s.strength = strength
        self.s.last_valid_frame = now

        if not self.s.online:
            if self._recover_since is None:
                self._recover_since = now
            elif now - self._recover_since >= self.recover_stable_s:
                self.s.online = True
        else:
            self._recover_since = now

        raw = (
            strength >= self.min_strength
            and self.min_detect_cm <= distance_cm <= self.max_detect_cm
        )

        if raw != self._last_raw:
            logger.debug(
                f"SENSOR {self.s.name} raw_detected={raw} "
                f"dist={distance_cm} strength={strength} "
                f"range_cm={self.min_detect_cm}-{self.max_detect_cm} "
                f"min_strength={self.min_strength}"
            )
            self._last_raw = raw

        self.s.raw_detected = raw

        if raw:
            if self._raw_since is None:
                self._raw_since = now
                logger.debug(f"SENSOR {self.s.name} debounce_start")

            if now - self._raw_since >= self.debounce_s:
                self.s.last_detect_at = now

                if not self.s.occupied:
                    self.s.occupied = True
                    self.s.first_detect_at = now
                    self.s.rising_edge_at = now

                    logger.info(
                        f"SENSOR {self.s.name} RISING occupied "
                        f"dist={distance_cm} strength={strength}"
                    )
        else:
            if self._raw_since is not None:
                logger.debug(f"SENSOR {self.s.name} debounce_clear")
                self._raw_since = None

    def tick(self, now: float | None = None):
        now = now if now is not None else time.monotonic()

        if (
            self.s.last_valid_frame is None
            or now - self.s.last_valid_frame > self.offline_timeout_s
        ):
            self.s.online = False
            self._recover_since = None

        if self.s.occupied and self.s.last_detect_at is not None:
            if now - self.s.last_detect_at > self.gap_hold_s:
                self.s.occupied = False
                self.s.falling_edge_at = now
                self.s.first_detect_at = None

                logger.info(
                    f"SENSOR {self.s.name} FALLING clear "
                    f"gap_hold_s={self.gap_hold_s}"
                )

        return self.s