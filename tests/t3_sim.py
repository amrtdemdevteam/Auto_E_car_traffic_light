"""Simulation harness for T3 controller tests (no hardware, no MQTT)."""
from __future__ import annotations

import json
from pathlib import Path

from trafficlight.t3 import frames as F
from trafficlight.t3.config import sensor_params, with_defaults
from trafficlight.t3.controller import Ack, T3Controller
from trafficlight.t3.sensors import FilteredSensor

ROOT = Path(__file__).resolve().parents[1]
DT = 0.05
FAR = (400, 800)      # nothing under the sensor: floor beyond max range
NEAR = (120, 1500)    # vehicle / hand in range


def t3_config(**timing) -> dict:
    raw = json.loads((ROOT / "config" / "settings.t3.example.json").read_text(encoding="utf-8"))
    cfg = with_defaults(raw)
    cfg["timing"].update(timing)
    return cfg


class FakeLink:
    """Displays that render a command `latency` s after it is sent, then ACK."""

    def __init__(self, latency: float = 0.1):
        self.epoch = "e1"
        self.latency = latency
        self.now = 0.0
        self._seq = 0
        self.history: dict[int, list[tuple[float, int, str, str]]] = {}
        self.dead: dict[int, float] = {}    # display -> time it stopped receiving

    def command(self, disp, frame, arg, now):
        hist = self.history.setdefault(disp, [])
        if hist and hist[-1][2] == frame and hist[-1][3] == arg:
            return hist[-1][1]
        self._seq += 1
        hist.append((now, self._seq, frame, arg))
        return self._seq

    def _received(self, disp, now):
        """Last command the physical display has actually rendered."""
        cut = min(now, self.dead.get(disp, now))
        got = [h for h in self.history.get(disp, []) if h[0] + self.latency <= cut]
        return got[-1] if got else None

    def shown(self, disp, now, ttl=5.0):
        rec = self._received(disp, now)
        if rec is None:
            return F.START
        if disp in self.dead and now - self.dead[disp] > ttl:
            return F.LINKLOST
        return rec[2]

    def last_ack(self, disp):
        rec = self._received(disp, self.now)
        if rec is None:
            return None
        at = self.dead.get(disp, self.now)
        return Ack(self.epoch, rec[1], rec[2], F.is_green(rec[2]), at, "t3-test")

    def current(self, disp):
        hist = self.history.get(disp, [])
        return hist[-1][2] if hist else None


class Sim:
    def __init__(self, cfg=None, latency=0.1, startup_occupied=()):
        self.cfg = cfg or t3_config()
        self.link = FakeLink(latency)
        self.sensors = {sid: FilteredSensor(sid, sensor_params(self.cfg, sid)) for sid in self.cfg["sensors"]}
        self.present: dict[str, bool] = {sid: sid in startup_occupied for sid in self.sensors}
        self.broken: set[str] = set()
        self.now = 0.0
        self.ctrl = T3Controller(self.cfg, self.sensors, self.link, self.now, wall=lambda: self.now)
        self.green_log: list[tuple[float, int]] = []
        self.displays = sorted(int(d) for d in self.cfg["displays"])

    def step(self, seconds: float = DT):
        end = self.now + seconds
        while self.now < end - 1e-9:
            self.now = round(self.now + DT, 6)
            self.link.now = self.now
            for sid, s in self.sensors.items():
                if sid in self.broken:
                    continue
                s.ingest(*(NEAR if self.present[sid] else FAR), self.now)
            events = []
            for s in self.sensors.values():
                s.tick(self.now)
                events.extend(s.pop_events())
            self.ctrl.tick(self.now, events)
            self._check_safety()

    def _check_safety(self):
        shown_green = [d for d in self.displays if F.is_green(self.link.shown(d, self.now))]
        assert len(shown_green) <= 1, f"t={self.now}: two displays green {shown_green}"
        commanded = [d for d in self.displays if F.is_green(self.link.current(d) or "")]
        assert len(commanded) <= 1, f"t={self.now}: two green commands {commanded}"
        if self.ctrl.state == "STARTING":
            assert not commanded, "green while STARTING"
        for d in shown_green:
            if not self.green_log or self.green_log[-1][1] != d:
                self.green_log.append((self.now, d))

    # scenario helpers
    def ready(self):
        self.step(3.2)
        assert self.ctrl.state != "STARTING", self.ctrl.state

    def on(self, sid):
        self.present[sid] = True

    def off(self, sid):
        self.present[sid] = False

    def pulse(self, sid, seconds):
        self.on(sid)
        self.step(seconds)
        self.off(sid)

    def shown(self, disp):
        return self.link.shown(disp, self.now)

    def until(self, cond, limit=60.0):
        t0 = self.now
        while not cond():
            self.step()
            assert self.now - t0 <= limit, "condition not reached"
        return self.now - t0
