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
