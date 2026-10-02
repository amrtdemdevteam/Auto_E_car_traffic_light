"""Admin test mode: fake sensor frames go through the same filters as real ones."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "raspberry_pi"))
from trafficlight.t3.config import with_defaults  # noqa: E402
from trafficlight.t3.sensors import SensorHub  # noqa: E402


def _hub():
    cfg = with_defaults(json.loads((ROOT / "config" / "settings.t3.example.json").read_text("utf-8")))
    return SensorHub(cfg), cfg


def _run(hub, t0, t1, step=0.05):
    t, ev = t0, []
    while t < t1:
        ev += hub.update(t)
        t += step
    return t, ev


def test_sim_vehicle_and_fault_follow_normal_filters():
    hub, _ = _hub()
    s = hub.sensors["C2"]
    assert hub.sim_sensor("C2", "present", 0.0) != "" and not s.online      # off: ignored
    hub.sim_set(True, 0.0)
    t, _ = _run(hub, 0.0, 1.5)
    assert s.online and not s.occupied
    hub.sim_sensor("C2", "present", t)
    t, _ = _run(hub, t, t + 0.5)
    assert s.occupied
    hub.sim_sensor("C2", "empty", t)
    t, _ = _run(hub, t, t + 2.0)
    assert not s.occupied
    hub.sim_sensor("C2", "dead", t)
    t, ev = _run(hub, t, t + 3.0)
    assert not s.online and any(e.kind == "offline" for e in ev)


def test_sim_pulse_returns_to_empty_and_times_out():
    hub, cfg = _hub()
    hub.sim_set(True, 0.0)
    t, _ = _run(hub, 0.0, 1.5)
    hub.sim_pulse("C2", t)
    assert hub.sim_state["C2"] == "present"
    t, _ = _run(hub, t, t + cfg["sim"]["pulse_s"] + 0.2)
    assert hub.sim_state["C2"] == "empty"
    _run(hub, t, t + cfg["sim"]["max_s"] + 5.0, step=1.0)
    assert not hub.sim_on                                                      # never left on by accident
