"""Lane 2 follow sensor and a lane switched off in the config (site change 2026-10-28).

Site layout: lane 3 (hand lane) is off, its sensor moved to lane 2 as C2.2, 7 m upstream of
the stop-line sensor C2.1 (the old C2).
"""
from __future__ import annotations

from t3_sim import Sim, t3_config
from trafficlight.t3 import frames as F
from trafficlight.t3.config import validate


def site_config(**timing):
    cfg = t3_config(**timing)
    sensors = cfg["sensors"]
    sensors["C2.1"] = sensors.pop("C2")
    sensors["C2.2"] = sensors.pop("C3")
    for lane in cfg["lanes"]:
        if lane["id"] == 2:
            lane["sensor"] = "C2.1"
            lane["follow_sensor"] = "C2.2"
        if lane["id"] == 3:
            lane["enabled"] = False
            lane.pop("sensor")
    return cfg


def greens_after(sim, t0):
    """Lanes granted green since t0, in order (two greens of one lane count twice)."""
    out = []
    for e in sim.ctrl.events:
        text = e["text"]
        if e["t"] >= t0 and " เขียว (ตั๋ว #" in text:
            out.append(int(text.split()[1]))
    return out


def test_site_config_is_valid_and_lane_off_needs_no_sensor():
    assert validate(site_config()) == []
    cfg = site_config()
    for lane in cfg["lanes"]:
        if lane["id"] == 4:
            lane.pop("sensor")              # an enabled lane still needs its sensor
    assert any("ต้องเลือกเซนเซอร์" in e for e in validate(cfg))


def test_follow_sensor_only_on_manual_vehicle_lanes():
    cfg = site_config()
    for lane in cfg["lanes"]:
        if lane["id"] == 5:
            lane["follow_sensor"] = "C2.2"
    assert any("เซนเซอร์ต่อคิวใช้ได้เฉพาะ" in e for e in validate(cfg))


def test_lane_off_display_is_dark_and_never_goes_green():
    sim = Sim(site_config())
    sim.ready()
    sim.step(1)
    assert sim.shown(3) == F.MAINT                 # dark panel (MAINT + DARK)
    assert sim.ctrl._frames[3] == (F.MAINT, F.MAINT_DARK)   # (test config: lane 3 on display 3)
    sim.on("C4")
    sim.until(lambda: sim.shown(4) == F.GO)
    assert 3 not in [d for _, d in sim.green_log]


def test_follower_goes_next_green_red_green_before_other_lanes():
    sim = Sim(site_config())
    sim.ready()
    t0 = sim.now
    sim.on("C2.1")                                 # vehicle 1 at the stop line
    sim.until(lambda: sim.shown(2) == F.GO)
    sim.on("C4")                                   # lane 4 starts waiting
    sim.step(0.5)
    sim.on("C2.2")                                 # vehicle 2 right behind
    sim.step(0.5)
    assert [t.follow for t in sim.ctrl.queue.ordered()] == [True, False]   # lane 2 follower ahead of lane 4
    sim.off("C2.1")                                # vehicle 1 drives off
    sim.step(1.0)
    sim.off("C2.2")
    sim.on("C2.1")                                 # vehicle 2 reaches the stop line
    sim.until(lambda: sim.shown(2) == F.STOP, limit=6)       # red between the two vehicles
    sim.until(lambda: sim.shown(2) == F.GO, limit=5)         # vehicle 2's own green
    sim.step(1.0)
    sim.off("C2.1")
    sim.until(lambda: sim.shown(4) == F.GO, limit=10)
    assert greens_after(sim, t0) == [2, 2, 4]


def test_follower_reaching_the_stop_line_on_its_own_green_is_not_a_new_vehicle():
    # site 2026-10-28: 2 vehicles gave 3 greens. Vehicle 2 drives the 7 m on its own green and
    # reaches C2.1 then: that is the vehicle being served, not a new ticket.
    sim = Sim(site_config())
    sim.ready()
    t0 = sim.now
    sim.on("C2.1")                                 # vehicle 1
    sim.until(lambda: sim.shown(2) == F.GO)
    sim.on("C2.2")                                 # vehicle 2 passes the follow sensor
    sim.step(0.5)
    sim.off("C2.2")
    sim.off("C2.1")                                # vehicle 1 drives off, vehicle 2 is still upstream
    sim.until(lambda: sim.shown(2) == F.STOP, limit=6)
    sim.until(lambda: sim.shown(2) == F.GO, limit=5)          # vehicle 2's green
    sim.step(2.0)
    sim.on("C2.1")                                 # vehicle 2 arrives at the stop line
    sim.step(1.0)
    assert sim.ctrl.queue.for_lane(2) == []
    sim.off("C2.1")
    sim.until(lambda: sim.shown(2) == F.STOP, limit=6)
    sim.step(8.0)
    assert greens_after(sim, t0) == [2, 2]


def test_third_vehicle_waits_for_the_next_round():
    sim = Sim(site_config())
    sim.ready()
    sim.on("C2.1")
    sim.until(lambda: sim.shown(2) == F.GO)
    sim.on("C4")
    sim.step(0.3)
    sim.on("C2.2")                                 # vehicle 2
    sim.step(0.5)
    sim.off("C2.2")
    sim.step(4.0)                                  # (gap longer than C2.2's gap hold: a new vehicle)
    sim.on("C2.2")                                 # vehicle 3
    sim.step(0.5)
    lane2 = sim.ctrl.queue.for_lane(2)
    assert len(lane2) == 1 and lane2[0].follow     # only vehicle 2 got the inserted ticket


def test_follow_sensor_ignored_while_lane_idle():
    sim = Sim(site_config())
    sim.ready()
    sim.on("C2.2")
    sim.step(1.0)
    assert sim.ctrl.queue.for_lane(2) == []        # C2.1 makes the ticket when the vehicle gets there


def test_dolly_gap_shorter_than_follow_gap_hold_is_one_vehicle():
    sim = Sim(site_config())
    sim.ready()
    sim.on("C4")
    sim.until(lambda: sim.shown(4) == F.GO)
    sim.on("C2.1")                                 # lane 2 waits
    sim.step(0.5)
    sim.on("C2.2")
    sim.step(0.5)
    sim.off("C2.2")                                # dolly gap under C2.2, shorter than its gap hold 1.2 s
    sim.step(1.0)
    sim.on("C2.2")
    sim.step(0.5)
    assert [t.follow for t in sim.ctrl.queue.for_lane(2)] == [False, True]


def test_follower_green_waits_for_arrival_then_ends_after_follow_arrive_s():
    sim = Sim(site_config())
    sim.ready()
    sim.on("C2.1")
    sim.until(lambda: sim.shown(2) == F.GO)
    sim.on("C2.2")
    sim.step(0.5)
    sim.off("C2.2")
    sim.off("C2.1")                                # vehicle 1 gone, vehicle 2 never reaches C2.1
    sim.until(lambda: sim.shown(2) == F.STOP, limit=6)
    sim.until(lambda: sim.shown(2) == F.GO, limit=5)          # follower's green
    t = sim.until(lambda: sim.shown(2) == F.STOP, limit=10)
    assert 6.5 <= t <= 7.6                                    # follow_arrive_s 7 s (+ display latency)


def test_auto_still_goes_before_the_follower():
    sim = Sim(site_config())
    sim.ready()
    t0 = sim.now
    sim.on("C2.1")
    sim.until(lambda: sim.shown(2) == F.GO)
    sim.on("C2.2")
    sim.step(0.5)
    sim.on("C1.2")                                 # Auto approaching
    sim.step(0.5)
    sim.on("C1.1")
    sim.off("C2.1")
    sim.off("C2.2")
    sim.step(0.5)
    sim.on("C2.1")                                 # vehicle 2 waits at the stop line
    sim.until(lambda: sim.shown(1) == F.GO, limit=8)
    sim.off("C1.2")
    sim.off("C1.1")
    sim.until(lambda: sim.shown(2) == F.GO, limit=12)
    assert greens_after(sim, t0) == [2, 1, 2]


def test_follow_sensor_fault_keeps_the_lane_running():
    sim = Sim(site_config())
    sim.ready()
    sim.broken.add("C2.2")
    sim.step(3.0)
    assert sim.ctrl.lanes[2].enabled
    sim.on("C2.1")
    sim.until(lambda: sim.shown(2) == F.GO)


def test_follow_sensor_gap_hold_defaults_to_1_2_s():
    from trafficlight.t3.config import sensor_params
    cfg = site_config()
    assert sensor_params(cfg, "C2.2")["gap_hold_s"] == 1.2      # not the manual 0.2 s
    assert sensor_params(cfg, "C2.1")["gap_hold_s"] == cfg["sensor_defaults"]["manual_gap_hold_s"]
