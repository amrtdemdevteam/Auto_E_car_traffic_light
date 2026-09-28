"""Config-error (setup) mode: never green, identify blinks red, ports reported."""
from __future__ import annotations

from t3_sim import t3_config
from trafficlight.t3 import frames as F
from trafficlight.t3 import runner


class FakeLink:
    def __init__(self, cfg):
        self.sent, self.states, self.results, self.calls = [], [], [], 0

    def command(self, disp, frame, arg, now):
        self.sent.append((disp, frame))

    def tick(self, now):
        pass

    def publish_state(self, st):
        self.states.append(st)

    def publish_result(self, cmd, text):
        self.results.append(text)

    def pop_commands(self):
        self.calls += 1
        if self.calls == 2:
            return [{"cmd": "identify", "display": 6}]
        if self.calls == 40:
            return [{"cmd": "apply_config"}]
        return []

    def close(self):
        pass


class FakeProbe:
    def __init__(self, *a, **k):
        pass

    def update(self, now, busy):
        pass

    def snapshot(self, now, assigned):
        return [{"path": "/dev/p1", "label": "#1", "sensor": None, "cm": 800, "strength": 900, "age_s": 0.1}]

    def close(self):
        pass


def test_setup_mode_never_green_and_identify(monkeypatch):
    cfg = t3_config()
    cfg["lanes"], cfg["sensors"] = [], {}
    links = []
    monkeypatch.setattr(runner, "DisplayLink", lambda c: links.append(FakeLink(c)) or links[-1])
    monkeypatch.setattr(runner, "PortProbe", FakeProbe)
    monkeypatch.setattr(runner.time, "sleep", lambda s: None)
    assert runner._config_error_loop(cfg, ["ยังไม่มีเลน"]) == 0
    link = links[0]
    frames = {f for _, f in link.sent}
    assert not any(F.is_green(f) for f in frames)
    assert {d for d, f in link.sent if f == F.TEST} == {6}
    assert "TEST" in link.results[0]
    assert link.states[0]["state"] == "CONFIG_ERROR" and link.states[0]["ports"][0]["cm"] == 800
