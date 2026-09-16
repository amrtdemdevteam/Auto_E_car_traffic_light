from __future__ import annotations
from dataclasses import dataclass
import time
from loguru import logger


@dataclass
class PairResult:
    triggered: bool = False
    wrong_direction: bool = False
    active: bool = False


class DirectionalPairDetector:
    """Confirm motion only when FIRST -> SECOND occurs within window_s.

    Internal body/dolly gaps are already absorbed by SensorState.gap_hold_s.
    Once a pair is confirmed, the detector latches the convoy as active until
    BOTH sensors are clear. Reverse travel is suppressed until both sensors clear
    so oscillating body/dolly edges cannot accidentally create a forward trigger.
    """
    def __init__(self, first: str, second: str, window_s: float, name: str):
        self.first, self.second = first, second
        self.window_s = float(window_s)
        self.name = name
        self._seen_first_at: float | None = None
        self._seen_second_at: float | None = None
        self._last_rising = {first: None, second: None}
        self._latched_active = False
        self._blocked_until_clear = False

    def _pair_clear(self, sensors: dict) -> bool:
        return (not sensors[self.first].occupied) and (not sensors[self.second].occupied)

    def _reset_pending(self):
        self._seen_first_at = None
        self._seen_second_at = None

    def _expire_pending(self, now: float):
        if self._seen_first_at is not None and now - self._seen_first_at > self.window_s:
            self._seen_first_at = None
        if self._seen_second_at is not None and now - self._seen_second_at > self.window_s:
            self._seen_second_at = None

    def _edge_is_stale(self, rising: float, now: float) -> bool:
        return rising > now or now - rising > self.window_s

    def update(self, sensors: dict, now: float | None = None) -> PairResult:
        now = now if now is not None else time.monotonic()
        result = PairResult(active=self._latched_active)

        # Missing/offline pair member: never synthesize a trigger from stale history.
        if not sensors[self.first].online or not sensors[self.second].online:
            self._reset_pending()
            self._latched_active = False
            self._blocked_until_clear = False
            return result

        pair_clear = self._pair_clear(sensors)
        if self._latched_active:
            if pair_clear:
                self._latched_active = False
                self._reset_pending()
            result.active = self._latched_active
            return result

        if self._blocked_until_clear:
            if pair_clear:
                self._blocked_until_clear = False
                self._reset_pending()
            return result

        self._expire_pending(now)

        # Process new rising edges only. SensorState creates a rising edge only after
        # debounce and only after its gap-hold occupancy has actually cleared.
        for name in (self.first, self.second):
            rising = sensors[name].rising_edge_at
            if rising is None or rising == self._last_rising[name]:
                continue
            self._last_rising[name] = rising

            if self._edge_is_stale(rising, now):
                logger.debug(
                    f"PAIR {self.name} ignored_stale_edge sensor={name} "
                    f"edge_at={rising:.3f} now={now:.3f}"
                )
                continue

            if name == self.first:
                # SECOND followed by FIRST => reverse direction. Block until clear.
                if self._seen_second_at is not None:
                    dt = rising - self._seen_second_at
                    if 0 <= dt <= self.window_s:
                        result.wrong_direction = True
                        self._blocked_until_clear = True
                        self._reset_pending()
                        logger.info(f"PAIR {self.name} wrong_direction {self.second}->{self.first} dt={dt:.3f}s")
                        return result
                self._seen_first_at = rising
            else:
                if self._seen_first_at is not None:
                    dt = rising - self._seen_first_at
                    if 0 <= dt <= self.window_s:
                        result.triggered = True
                        self._latched_active = True
                        result.active = True
                        self._reset_pending()
                        logger.info(f"PAIR {self.name} triggered {self.first}->{self.second} dt={dt:.3f}s")
                        return result
                    if -self.window_s <= dt < 0:
                        result.wrong_direction = True
                        self._blocked_until_clear = True
                        self._reset_pending()
                        logger.info(f"PAIR {self.name} wrong_direction {self.second}->{self.first} dt={-dt:.3f}s")
                        return result
                self._seen_second_at = rising

        self._expire_pending(now)
        return result
