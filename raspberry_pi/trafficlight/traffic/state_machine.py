from __future__ import annotations
from enum import Enum
import time
from loguru import logger

class TrafficState(str, Enum):
    IDLE = "idle"
    YELLOW = "yellow"
    RED = "red"
    RETURN = "return"

class StateMachine:
    def __init__(self, timing: dict):
        self.state = TrafficState.IDLE
        self.red_duration = float(timing["red_duration_s"])
        self.red_clear_delay = float(timing.get("red_clear_delay_s", 1.0))
        self.return_duration = float(timing["return_yellow_s"])
        self.yellow_clear_delay = float(timing["yellow_clear_delay_s"])
        self.state_since = time.monotonic()
        self.yellow_clear_since = None
        self.red_clear_since = None

    def _set(self, new_state: TrafficState, now: float):
        if new_state != self.state:
            logger.info(f"STATE {self.state.value.upper()} -> {new_state.value.upper()}")
            self.state = new_state
            self.state_since = now
            self.yellow_clear_since = None
            self.red_clear_since = None

    def update(self, yellow_trigger: bool, red_trigger: bool,
               yellow_active: bool, now: float | None = None,
               red_exit_sensor_active: bool = True) -> TrafficState:
        now = now if now is not None else time.monotonic()
        if red_trigger:
            if self.state == TrafficState.RED:
                self.red_clear_since = None
            else:
                self._set(TrafficState.RED, now)
            return self.state

        if self.state == TrafficState.IDLE:
            if yellow_trigger or yellow_active:
                self._set(TrafficState.YELLOW, now)
        elif self.state == TrafficState.YELLOW:
            if yellow_active:
                self.yellow_clear_since = None
            else:
                if self.yellow_clear_since is None:
                    self.yellow_clear_since = now
                elif now - self.yellow_clear_since >= self.yellow_clear_delay:
                    self._set(TrafficState.IDLE, now)
        elif self.state == TrafficState.RED:
            if red_exit_sensor_active:
                self.red_clear_since = None
            else:
                if self.red_clear_since is None:
                    self.red_clear_since = now
                elif now - self.red_clear_since >= self.red_clear_delay:
                    self._set(TrafficState.RETURN, now)
        elif self.state == TrafficState.RETURN:
            if now - self.state_since >= self.return_duration:
                self._set(TrafficState.YELLOW if yellow_active or yellow_trigger else TrafficState.IDLE, now)
        return self.state
