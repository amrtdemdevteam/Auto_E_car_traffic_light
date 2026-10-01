"""T3 controller behaviour and safety invariants (docs/T3_DESIGN.md)."""
from __future__ import annotations

import pytest

from t3_sim import Sim, t3_config
from trafficlight.t3 import frames as F
from trafficlight.t3.config import validate


def test_example_config_is_valid():
    assert validate(t3_config()) == []


def test_startup_is_never_green_then_all_red_x():
    sim = Sim()
    sim.on("C2")                       # a car is waiting while the system boots
    sim.step(2.0)
    assert sim.ctrl.state == "STARTING"
    assert all(sim.shown(d) in (F.START, ) for d in sim.displays if sim.link.current(d))
    sim.step(1.2)
    assert sim.ctrl.state in ("IDLE", "SWITCHING", "GREEN")


def test_vehicle_already_on_sensor_at_startup_gets_a_ticket():
    sim = Sim(startup_occupied=("C4",))
    sim.ready()
    sim.until(lambda: sim.shown(4) == F.GO, limit=3)


def test_idle_all_displays_red_x():
    sim = Sim()
    sim.ready()
    sim.step(1)
    assert [sim.shown(d) for d in sim.displays] == [F.STOP] * 5


def test_manual_lane_green_until_clear_plus_3s():
    sim = Sim()
    sim.ready()
    sim.on("C2")
    sim.until(lambda: sim.shown(2) == F.GO, limit=2.5)
    sim.step(4)
    sim.off("C2")                       # tail passes the sensor
    t = sim.until(lambda: sim.shown(2) == F.STOP, limit=10)
    assert 3.1 <= t <= 3.5              # 0.2 s manual gap hold + 3.0 s + display latency


def test_switch_keeps_all_red_at_least_1s():
    sim = Sim()
    sim.ready()
    sim.on("C2")
    sim.on("C4")
    sim.until(lambda: sim.shown(2) == F.GO)
    sim.off("C2")
    sim.until(lambda: sim.shown(2) == F.STOP)
    t_red = sim.now
    sim.until(lambda: sim.shown(4) == F.GO)
    assert sim.now - t_red >= 1.0


def test_auto_waits_for_current_green_then_goes_before_older_manual():
    sim = Sim()
    sim.ready()
    sim.on("C2")                                   # C2 gets green
    sim.until(lambda: sim.shown(2) == F.GO)
    sim.on("C4")                                   # C4 asks first
    sim.step(0.5)
    sim.pulse("C1.2", 1.0)                         # then an Auto is seen far away
    assert sim.shown(2) == F.GO                    # the running green is not cut
    sim.step(1.0)
    sim.on("C1.1")                                 # Auto arrives near the junction
    sim.off("C2")
    sim.until(lambda: sim.shown(1) == F.GO, limit=8)
    assert sim.shown(4) == F.STOP                  # Auto overtook the older manual ticket
    sim.step(2)
    sim.off("C1.1")
    sim.until(lambda: sim.shown(4) == F.GO, limit=10)


def test_auto_head_holds_junction_until_it_arrives():
    sim = Sim()
    sim.ready()
    sim.pulse("C1.2", 0.5)
    sim.on("C4")
    sim.step(4.0)                                  # Auto still on its way (< 7 s)
    assert sim.shown(4) == F.STOP and sim.shown(1) == F.STOP
    sim.on("C1.1")
    sim.until(lambda: sim.shown(1) == F.GO, limit=2.5)


def test_auto_ticket_expires_after_7s_and_queue_moves_on():
    sim = Sim()
    sim.ready()
    sim.pulse("C1.2", 0.5)
    sim.on("C4")
    t = sim.until(lambda: sim.shown(4) == F.GO, limit=12)
    assert 6.0 <= t <= 8.5
    assert sim.shown(1) == F.STOP


def test_consecutive_autos_keep_b1_green_without_red_between():
    sim = Sim()
    sim.ready()
    sim.pulse("C1.2", 0.5)
    sim.step(1.0)
    sim.pulse("C1.2", 0.5)                         # second Auto seen far away
    sim.on("C1.1")
    sim.until(lambda: sim.shown(1) == F.GO)
    sim.step(2)
    sim.off("C1.1")                                # first Auto passed
    sim.step(1.5)
    sim.on("C1.1")                                 # second Auto arrives during the 4 s tail
    sim.step(3)
    sim.off("C1.1")
    sim.until(lambda: sim.shown(1) == F.STOP, limit=10)
    b1 = [d for _, d in sim.green_log if d == 1]
    assert len(b1) == 1                            # one continuous green, no red in between


def test_hand_swinging_creates_no_ticket_hold_3s_creates_one():
    sim = Sim()
    sim.ready()
    for _ in range(5):                             # arm swinging through the beam
        sim.pulse("C3", 0.3)
        assert sim.shown(3) in (F.HOLD, F.STOP)
        sim.step(0.6)
    assert sim.ctrl.queue.for_lane(3) == []
    sim.on("C4")                                   # keep lane 4 busy so the ticket waits
    sim.until(lambda: sim.shown(4) == F.GO)
    sim.on("C3")
    sim.step(1.2)
    assert sim.shown(3) == F.HAND1
    sim.step(1.0)
    assert sim.shown(3) == F.HAND2
    sim.step(1.0)
    assert sim.shown(3) == F.HANDOK
    assert len(sim.ctrl.queue.for_lane(3)) == 1
    sim.off("C3")
    sim.step(1.0)
    sim.pulse("C3", 3.5)                           # asking again while waiting
    assert len(sim.ctrl.queue.for_lane(3)) == 1    # still one ticket


def test_hand_short_dropout_is_tolerated():
    sim = Sim()
    sim.ready()
    sim.on("C5")
    sim.step(1.5)
    sim.off("C5")
    sim.step(0.15)                                 # shorter than 300 ms grace
    sim.on("C5")
    sim.step(1.6)
    assert len(sim.ctrl.queue.for_lane(5)) == 1


def test_special_lane_fixed_green_default_3s():
    sim = Sim()
    sim.ready()
    sim.pulse("C3", 3.2)
    sim.until(lambda: sim.shown(3) == F.GO, limit=3)
    t = sim.until(lambda: sim.shown(3) != F.GO, limit=10)
    assert 2.9 <= t <= 3.3


def test_same_lane_next_car_keeps_green_when_nobody_else_waits():
    sim = Sim()
    sim.ready()
    sim.on("C2")
    sim.until(lambda: sim.shown(2) == F.GO)
    sim.step(2)
    sim.off("C2")
    sim.step(2.0)                                  # gap > gap hold: next car is a new ticket
    sim.on("C2")
    sim.step(2)
    sim.off("C2")
    sim.until(lambda: sim.shown(2) == F.STOP, limit=10)
    assert [d for _, d in sim.green_log] == [2]


def test_inactive_lane_sensor_fault_isolated_and_recovers():
    sim = Sim()
    sim.ready()
    sim.broken.add("C4")
    sim.step(2.2)
    assert sim.shown(4) == F.SENSOR
    sim.on("C2")
    sim.until(lambda: sim.shown(2) == F.GO)        # other lanes keep working
    sim.broken.discard("C4")
    sim.step(1.5)
    assert "sensor:C4" not in sim.ctrl.lanes[4].reasons


def test_active_lane_sensor_fault_ends_green_and_holds_12s():
    sim = Sim()
    sim.ready()
    sim.on("C2")
    sim.until(lambda: sim.shown(2) == F.GO)
    sim.on("C4")
    sim.broken.add("C2")
    t_fault = sim.until(lambda: sim.shown(2) != F.GO, limit=3)
    assert t_fault <= 2.3                          # offline after 2.0 s, green ends at once
    assert sim.ctrl.state == "FAULT_HOLD"
    t = sim.until(lambda: sim.shown(4) == F.GO, limit=20)
    assert t >= 12.0
    assert sim.shown(2) == F.SENSOR


def test_special_lane_sensor_fault_during_green_finishes_its_green():
    sim = Sim()
    sim.ready()
    sim.pulse("C3", 3.2)
    sim.until(lambda: sim.shown(3) == F.GO)
    sim.broken.add("C3")
    sim.step(2.2)
    assert sim.shown(3) == F.GO
    sim.until(lambda: sim.shown(3) == F.SENSOR, limit=4)


def test_far_sensor_fault_c11_takes_over():
    sim = Sim()
    sim.ready()
    sim.broken.add("C1.2")
    sim.step(2.5)
    assert sim.ctrl.lanes[1].enabled
    sim.on("C1.1")
    sim.until(lambda: sim.shown(1) == F.GO, limit=3)


def test_near_sensor_fault_disables_auto_lane():
    sim = Sim()
    sim.ready()
    sim.broken.add("C1.1")
    sim.step(2.5)
    assert not sim.ctrl.lanes[1].enabled
    assert sim.shown(1) == F.SENSOR


def test_dead_display_closes_only_its_lane_and_releases_after_the_timeout():
    sim = Sim()
    sim.ready()
    sim.on("C2")
    sim.until(lambda: sim.shown(2) == F.GO)
    sim.on("C4")
    sim.off("C2")
    sim.step(3.0)                                  # green is about to end (0.2 + 3 s)
    assert sim.shown(2) == F.GO
    sim.link.dead[2] = sim.now                     # B2 cable cut: it never gets the red
    t_dead = sim.now
    sim.until(lambda: sim.shown(4) == F.GO, limit=20)
    # B2 may still be showing its last green until its own command expires,
    # so B4 must not go before display_fault_timeout_s, and must go after it
    hold = sim.ctrl.t["display_fault_timeout_s"]
    assert hold <= sim.now - t_dead <= hold + 2.0
    assert "display" in sim.ctrl.lanes[2].reasons   # only lane 2 is closed
    assert sim.ctrl.lanes[4].enabled


def test_display_lost_while_green_ends_that_green():
    sim = Sim()
    sim.ready()
    sim.on("C2")
    sim.until(lambda: sim.shown(2) == F.GO)
    sim.link.dead[2] = sim.now                     # B2 stops answering mid-green
    t_dead = sim.now
    sim.until(lambda: sim.ctrl.active_lane is None, limit=5)
    assert sim.now - t_dead <= sim.ctrl.t["display_ack_timeout_s"] + 0.5


def test_maintenance_during_green_waits_for_end_of_green():
    sim = Sim()
    sim.ready()
    sim.on("C2")
    sim.until(lambda: sim.shown(2) == F.GO)
    msg = sim.ctrl.command({"cmd": "maintenance", "lane": 2, "on": True}, sim.now)
    assert "จบรอบ" in msg
    sim.step(1)
    assert sim.shown(2) == F.GO
    sim.off("C2")
    sim.until(lambda: sim.shown(2) == F.MAINT, limit=8)


def test_round_robin_on_exact_tie():
    sim = Sim()
    sim.ready()
    q = sim.ctrl.queue
    q.last_served_lane = 2
    q.add(2, "manual", 100.0, "C2")
    q.add(4, "manual", 100.0, "C4")
    assert q.head().lane == 4
    q.last_served_lane = 4
    assert q.head().lane == 2


def test_restart_request_waits_until_no_green():
    sim = Sim()
    sim.ready()
    sim.on("C2")
    sim.until(lambda: sim.shown(2) == F.GO)
    sim.ctrl.command({"cmd": "apply_config"}, sim.now)
    assert not sim.ctrl.can_exit()
    sim.off("C2")
    sim.until(lambda: sim.ctrl.can_exit(), limit=10)
    assert sim.shown(2) == F.STOP


@pytest.mark.parametrize("change,needle", [
    (lambda c: c["lanes"][1].update(display=1), "ถูกใช้ซ้ำ"),
    (lambda c: c["timing"].update(switch_all_red_s=0.2), "สลับเลน"),
    (lambda c: c["hand"].update(grace_ms=0), "อนุโลมมือ"),
    (lambda c: c["lanes"][0].update(far_sensor=None), "เลน Auto"),
])
def test_config_validation_errors(change, needle):
    cfg = t3_config()
    change(cfg)
    assert any(needle in e for e in validate(cfg))


def test_stale_sensor_is_never_reported_clear():
    from trafficlight.t3.sensors import FilteredSensor
    cfg = t3_config()
    from trafficlight.t3.config import sensor_params
    s = FilteredSensor("C2", sensor_params(cfg, "C2"))
    t = 0.0
    while t < 2.0:                       # online, then vehicle present
        t += 0.05
        s.ingest(*( (400, 800) if t < 1.2 else (120, 1500) ), t)
        s.tick(t)
    assert s.online and s.occupied
    s.pop_events()
    while t < 3.9:                       # frames stop (cable cut) for 1.9 s
        t += 0.05
        s.tick(t)
    kinds = [e.kind for e in s.pop_events()]
    assert "clear" not in kinds and s.occupied
    t += 0.2
    s.tick(t)
    assert [e.kind for e in s.pop_events()] == ["offline"]
    assert not s.online
