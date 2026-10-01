import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "raspberry_pi"))
from trafficlight.sensor.sensor import SensorState


def test_debounce_and_gap_hold_merge_short_dolly_gap():
    s = SensorState("S1", 30, 250, 100, 200, 1.2, 2.0, 0.0)
    s.ingest(200, 300, 0.0)
    s.ingest(200, 300, 0.21)
    assert s.s.occupied
    first_edge = s.s.rising_edge_at
    # clear raw for less than gap_hold: remains occupied and no new rising edge
    s.ingest(300, 300, 0.5)
    s.tick(1.0)
    assert s.s.occupied
    s.ingest(190, 300, 1.05)
    s.ingest(190, 300, 1.30)
    assert s.s.rising_edge_at == first_edge


def test_long_gap_creates_new_vehicle_edge():
    s = SensorState("S1", 30, 250, 100, 200, 1.2, 2.0, 0.0)
    s.ingest(200, 300, 0.0); s.ingest(200, 300, 0.21)
    first = s.s.rising_edge_at
    s.ingest(300, 300, 0.3); s.tick(1.6)
    assert not s.s.occupied
    s.ingest(200, 300, 2.0); s.ingest(200, 300, 2.25)
    assert s.s.rising_edge_at != first


def test_low_strength_is_not_detected_but_frame_is_online():
    s = SensorState("S1", 30, 250, 100, 0, 1.2, 2.0, 0.0)
    s.ingest(100, 50, 1.0)
    s.ingest(100, 50, 1.01)
    assert s.s.online
    assert not s.s.raw_detected


def test_field_distance_boundaries_are_inclusive():
    s = SensorState("S1", 30, 250, 100, 0, 1.2, 2.0, 0.0)

    s.ingest(29, 300, 1.0)
    assert not s.s.raw_detected

    s.ingest(30, 300, 2.0)
    assert s.s.raw_detected

    s.ingest(250, 300, 3.0)
    assert s.s.raw_detected

    s.ingest(251, 300, 4.0)
    assert not s.s.raw_detected


def _sensor(**kw):
    from trafficlight.t3.config import DEFAULTS
    from trafficlight.t3.sensors import FilteredSensor
    p = dict(DEFAULTS["sensor_defaults"])
    p.update(kw)
    return FilteredSensor("S", p)


def test_data_gap_does_not_count_towards_clear_or_debounce():
    s = _sensor(gap_hold_s=0.2, offline_timeout_s=5.0)
    t = 0.0
    while t < 2.5:                                  # comes online, then a vehicle is present
        t += 0.05
        s.ingest(*((400, 800) if t < 1.2 else (120, 1500)), t)
        s.tick(t)
    assert s.online and s.occupied
    s.pop_events()
    t += 1.0                                        # no data for 1 s
    s.ingest(400, 800, t)                           # first frame back says "nothing"
    s.tick(t)
    assert s.occupied                               # gap hold restarts from the returning data
    for _ in range(8):
        t += 0.05
        s.ingest(400, 800, t)
        s.tick(t)
    assert not s.occupied


def test_hand_detector_ignores_stale_frames():
    from trafficlight.t3.config import DEFAULTS
    from trafficlight.t3.sensors import HandDetector
    s = _sensor(offline_timeout_s=10.0)
    h = HandDetector(s, dict(DEFAULTS["hand"]))
    t, made = 0.0, False
    while t < 1.2:                                  # sensor comes online
        t += 0.05
        s.ingest(400, 800, t)
        s.tick(t)
    t0 = t
    while t < t0 + 1.0:                             # hand held for 1 s ...
        t += 0.05
        s.ingest(60, 1500, t)
        s.tick(t)
        made |= h.update(t, True)
    while t < 6.0:                                  # ... then the data stops (cable cut)
        t += 0.05
        s.tick(t)
        made |= h.update(t, True)
    assert not made
