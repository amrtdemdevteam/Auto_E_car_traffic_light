"""Per-lane parameters, Auto/Manual(+mode) lane types, identify, port probe."""
from __future__ import annotations

from t3_sim import Sim, t3_config
from trafficlight.t3 import frames as F
from trafficlight.t3.config import lane_kind, validate
from trafficlight.t3.ports import PortProbe


def _lane(cfg, lane_id):
    return next(l for l in cfg["lanes"] if l["id"] == lane_id)


def test_manual_hand_mode_is_the_same_as_special():
    cfg = t3_config()
    for lid in (3, 5):
        lane = _lane(cfg, lid)
        lane["type"], lane["mode"] = "manual", "hand"
    assert lane_kind(_lane(cfg, 3)) == "special" and lane_kind(_lane(cfg, 2)) == "manual"
    assert validate(cfg) == []
    sim = Sim(cfg)
    sim.ready()
    sim.pulse("C3", 3.2)
    sim.until(lambda: sim.shown(3) == F.GO, limit=3)
    t = sim.until(lambda: sim.shown(3) != F.GO, limit=10)
    assert 2.9 <= t <= 3.3


def test_per_lane_special_green_overrides_type_default_only_for_that_lane():
    cfg = t3_config()
    _lane(cfg, 3)["params"] = {"special_green_s": 8.0}
    assert validate(cfg) == []
    sim = Sim(cfg)
    sim.ready()
    sim.pulse("C3", 3.2)
    sim.until(lambda: sim.shown(3) == F.GO, limit=3)
    assert 7.9 <= sim.until(lambda: sim.shown(3) != F.GO, limit=12) <= 8.3
    sim.pulse("C5", 3.2)
    sim.until(lambda: sim.shown(5) == F.GO, limit=5)
    assert 2.9 <= sim.until(lambda: sim.shown(5) != F.GO, limit=10) <= 3.3


def test_per_lane_manual_clear_time():
    cfg = t3_config()
    _lane(cfg, 2)["params"] = {"manual_clear_s": 1.0, "min_green_s": 0.5}
    sim = Sim(cfg)
    sim.ready()
    sim.on("C2")
    sim.until(lambda: sim.shown(2) == F.GO, limit=2.5)
    sim.step(2)
    sim.off("C2")
    t = sim.until(lambda: sim.shown(2) == F.STOP, limit=10)
    assert 1.1 <= t <= 1.5              # 0.2 s manual gap hold + 1.0 s + latency


def test_per_lane_hand_hold_time():
    base = Sim()
    base.ready()
    base.pulse("C5", 1.9)               # 0.2 s debounce + default 2 s hold: no ticket yet
    assert not base.ctrl.queue.for_lane(5) and base.ctrl.active_lane != 5
    cfg = t3_config()
    _lane(cfg, 5)["params"] = {"hold_s": 1.5}
    sim = Sim(cfg)
    sim.ready()
    sim.pulse("C5", 1.9)                # 0.2 s debounce + 1.5 s hold
    assert len(sim.ctrl.queue.for_lane(5)) == 1 or sim.ctrl.active_lane == 5


def test_lane_params_validation():
    cfg = t3_config()
    _lane(cfg, 2)["params"] = {"special_green_s": 5}          # not a manual-vehicle key
    assert any("ใช้กับเลนประเภทนี้ไม่ได้" in e for e in validate(cfg))
    cfg = t3_config()
    _lane(cfg, 1)["params"] = {"auto_clear_s": -1}
    assert any("มากกว่า 0" in e for e in validate(cfg))
    cfg = t3_config()
    _lane(cfg, 2)["type"], _lane(cfg, 2)["mode"] = "manual", "wave"
    assert any("ตรวจรถ หรือ ยื่นมือ" in e for e in validate(cfg))
    cfg = t3_config()
    cfg["sensors"]["C2"]["min_detect_cm"] = 300              # >= max 190
    assert any("น้อยกว่าระยะไกลสุด" in e for e in validate(cfg))


def test_identify_blinks_red_only_and_refuses_the_green_lane():
    sim = Sim()
    sim.ready()
    assert "TEST" in sim.ctrl.command({"cmd": "identify", "display": 7}, sim.now)
    seen = set()
    for _ in range(40):
        sim.step()
        seen.add(sim.link.current(7))
    assert seen == {F.TEST} and sim.link.history[7][-1][3] == "B7"
    sim.step(5.0)
    assert sim.link.current(7) == F.CONFIG
    sim.on("C2")
    sim.until(lambda: sim.shown(2) == F.GO, limit=3)
    assert "ใช้งานอยู่" in sim.ctrl.command({"cmd": "identify", "display": 2}, sim.now)
    assert sim.shown(2) == F.GO


class _Frame:
    def __init__(self, cm):
        self.distance_cm, self.strength = cm, 900


class _Reader:
    values = {"/dev/p1": 820, "/dev/p2": 35}

    def __init__(self, path, baud):
        self.path = path

    def read_available(self):
        return [_Frame(self.values[self.path])]

    def close(self):
        pass


def test_port_probe_reads_free_ports_and_skips_busy_ones():
    ports = [{"path": "/dev/p1", "label": "#1"}, {"path": "/dev/p2", "label": "#2"}]
    probe = PortProbe(discover_fn=lambda: ports, reader_factory=_Reader)
    probe.update(0.0, busy={"/dev/p2"})
    assert set(probe.probes) == {"/dev/p1"}
    rows = probe.snapshot(0.1, {"/dev/p2": {"id": "C2", "distance_cm": 40, "strength": 1000, "age_s": 0.0}})
    assert rows[0]["cm"] == 820 and rows[0]["sensor"] is None
    assert rows[1]["sensor"] == "C2" and rows[1]["cm"] == 40


def test_manual_vehicle_sensor_uses_its_own_gap_hold():
    from trafficlight.t3.config import sensor_params, with_defaults
    cfg = with_defaults({
        "lanes": [
            {"id": 1, "type": "auto", "near_sensor": "A1", "far_sensor": "A2"},
            {"id": 2, "type": "manual", "mode": "vehicle", "sensor": "M"},
            {"id": 3, "type": "manual", "mode": "hand", "sensor": "H"},
            {"id": 4, "type": "manual", "mode": "vehicle", "sensor": "M2"}],
        "sensors": {"A1": {}, "A2": {}, "M": {}, "H": {}, "M2": {"gap_hold_s": 0.7}}})
    sd = cfg["sensor_defaults"]
    assert sensor_params(cfg, "A1")["gap_hold_s"] == sd["gap_hold_s"]
    assert sensor_params(cfg, "M")["gap_hold_s"] == sd["manual_gap_hold_s"]
    assert sensor_params(cfg, "H")["gap_hold_s"] == sd["manual_gap_hold_s"]
    assert sensor_params(cfg, "M2")["gap_hold_s"] == 0.7      # the sensor's own value wins


def test_manual_max_pending_must_be_a_positive_integer():
    cfg = t3_config()
    cfg["timing"]["manual_max_pending"] = 0
    assert any("manual_max_pending" in e for e in validate(cfg))
    cfg = t3_config()
    _lane(cfg, 2)["params"] = {"manual_max_pending": 1.5}
    assert any("จำนวนเต็ม" in e for e in validate(cfg))
    cfg = t3_config()
    _lane(cfg, 2)["params"] = {"manual_max_pending": 2}
    assert validate(cfg) == []


def test_green_frame_choices_include_the_combined_arrows_only():
    cfg = t3_config()
    for frame in (F.GO, F.GO_RIGHT, F.GO_LEFT, F.LEFT_RIGHT, F.GO_3WAY, F.LEFT, F.RIGHT):
        _lane(cfg, 1)["green_frame"] = frame
        assert validate(cfg) == [], frame
    _lane(cfg, 1)["green_frame"] = "GO_N"
    assert any("ภาพไฟเขียว" in e for e in validate(cfg))


def test_lane_with_combined_green_frame_shows_it_while_it_has_the_green():
    cfg = t3_config()
    _lane(cfg, 1)["green_frame"] = F.GO_RIGHT
    sim = Sim(cfg)
    sim.ready()
    sim.pulse("C1.1", 3.2)
    sim.until(lambda: sim.shown(1) == F.GO_RIGHT, limit=5)
    assert all(F.is_green(f) for f in (F.GO_RIGHT, F.GO_LEFT, F.LEFT_RIGHT, F.GO_3WAY))


def test_green_mask_must_have_at_least_one_direction():
    cfg = t3_config()
    for mask in (1, 5, 21, 31):
        _lane(cfg, 1)["green_mask"] = mask
        assert validate(cfg) == [], mask
    for bad in (0, 32, -1, "5", True, None):
        _lane(cfg, 1)["green_mask"] = bad
        assert any("ทิศลูกศร" in e for e in validate(cfg)), bad


def test_lane_with_green_mask_shows_arrow_frame_with_the_mask():
    cfg = t3_config()
    _lane(cfg, 1)["green_frame"] = F.GO_RIGHT     # mask wins over the legacy frame
    _lane(cfg, 1)["green_mask"] = 31
    sim = Sim(cfg)
    sim.ready()
    sim.pulse("C1.1", 3.2)
    sim.until(lambda: sim.shown(1) == F.ARROW, limit=5)
    assert sim.ctrl._frames[1] == (F.ARROW, "31")
    assert F.is_green(F.ARROW)


def test_legacy_frames_map_to_masks():
    assert F.mask_of(F.GO) == F.DIR_BITS["U"]
    assert F.mask_of(F.GO_3WAY) == 1 + 4 + 16
    assert F.mask_of(F.LEFT_RIGHT) == 1 + 16


def test_firmware_and_web_bitmaps_match_the_design():
    import importlib.util, json, pathlib, re
    root = pathlib.Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location("arrow_design", root / "tools" / "arrow_design.py")
    ad = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ad)
    maps = ad.bitmaps()
    header = (root / "esp32_display_t3" / "src" / "arrow_bitmaps.h").read_text()
    rows = [int(v, 16) for v in re.findall(r"0x([0-9A-F]{16})ULL", header)]
    assert rows == [maps[m][y] for m in range(1, 32) for y in range(32)]
    led = (root / "raspberry_pi" / "trafficlight" / "web" / "static" / "led.js").read_text()
    js = json.loads(re.search(r"var ARROW_BITMAP = (\[.*?\]);", led).group(1).replace("'", '"'))
    assert js == ["".join(f"{r:016X}" for r in maps[m]) for m in range(1, 32)]
    main = (root / "esp32_display_t3" / "src" / "main.cpp").read_text()
    assert '"ARROW"' in main and "ARROW_BITMAP" in main
