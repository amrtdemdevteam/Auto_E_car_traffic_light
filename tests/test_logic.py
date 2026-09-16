import sys
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "raspberry_pi"))
from trafficlight.app import red_exit_sensor_active
from trafficlight.traffic.state_machine import StateMachine, TrafficState
from trafficlight.traffic.pair_detector import DirectionalPairDetector


def snap(*, occ=False, rising=None, online=True):
    return SimpleNamespace(occupied=occ, rising_edge_at=rising, online=online)


def s1_exit_snap(*, occ=False, online=True, last_valid_frame=0.0):
    return SimpleNamespace(occupied=occ, online=online, last_valid_frame=last_valid_frame)


def pair_inputs(s1=False, s2=False, r1=None, r2=None, online=True):
    return {"S1": snap(occ=s1, rising=r1, online=online), "S2": snap(occ=s2, rising=r2, online=online)}


def field_inputs(s1=False, s2=False, s3=False, s4=False, r1=None, r2=None, r3=None, r4=None, online=True):
    return {
        "S1": snap(occ=s1, rising=r1, online=online),
        "S2": snap(occ=s2, rising=r2, online=online),
        "S3": snap(occ=s3, rising=r3, online=online),
        "S4": snap(occ=s4, rising=r4, online=online),
    }


def test_s1_alone_does_not_trigger_or_activate_yellow():
    p = DirectionalPairDetector("S4", "S3", 5.0, "YELLOW")
    r = p.update(field_inputs(s4=True, r4=10.0), 10.0)
    assert not r.triggered
    assert not r.active


def test_correct_direction_triggers_and_latches_until_both_clear():
    p = DirectionalPairDetector("S4", "S3", 5.0, "YELLOW")
    p.update(field_inputs(s4=True, r4=10.0), 10.0)
    r = p.update(field_inputs(s4=True, s3=True, r4=10.0, r3=10.6), 10.6)
    assert r.triggered and r.active
    # body/dolly gaps that do not clear both remain same convoy
    assert p.update(field_inputs(s4=False, s3=True, r4=10.0, r3=10.6), 11.0).active
    assert not p.update(field_inputs(s4=False, s3=False, r4=10.0, r3=10.6), 12.0).active


def test_yellow_pair_accepts_exact_five_second_window():
    p = DirectionalPairDetector("S4", "S3", 5.0, "YELLOW")
    p.update(field_inputs(s4=True, r4=10.0), 10.0)
    assert p.update(field_inputs(s4=True, s3=True, r4=10.0, r3=15.0), 15.0).triggered


def test_red_pair_triggers_in_field_direction():
    p = DirectionalPairDetector("S2", "S1", 5.0, "RED")
    p.update(field_inputs(s2=True, r2=20.0), 20.0)
    assert p.update(field_inputs(s2=True, s1=True, r2=20.0, r1=24.9), 24.9).triggered


def test_red_pair_enters_red_immediately():
    p = DirectionalPairDetector("S2", "S1", 5.0, "RED")
    sm = StateMachine({"red_duration_s":5,"red_clear_delay_s":1,"return_yellow_s":5,"yellow_clear_delay_s":5})
    p.update(field_inputs(s2=True, r2=20.0), 20.0)
    r = p.update(field_inputs(s2=True, s1=True, r2=20.0, r1=20.5), 20.5)
    assert sm.update(False, r.triggered, False, 20.5, red_exit_sensor_active=True) == TrafficState.RED


def test_idle_red_trigger_enters_red_immediately():
    sm = StateMachine({"red_duration_s":5,"red_clear_delay_s":1,"return_yellow_s":5,"yellow_clear_delay_s":5})
    assert sm.update(False, True, False, 10.0, red_exit_sensor_active=True) == TrafficState.RED


def test_yellow_red_trigger_preempts_to_red_immediately():
    sm = StateMachine({"red_duration_s":5,"red_clear_delay_s":1,"return_yellow_s":5,"yellow_clear_delay_s":5})
    assert sm.update(True, False, True, 10.0) == TrafficState.YELLOW
    assert sm.update(False, True, True, 11.0, red_exit_sensor_active=True) == TrafficState.RED


def test_return_red_trigger_preempts_to_red_immediately():
    sm = StateMachine({"red_duration_s":5,"red_clear_delay_s":1,"return_yellow_s":5,"yellow_clear_delay_s":5})
    sm.state = TrafficState.RETURN
    sm.state_since = 100.0
    assert sm.update(False, True, False, 101.0, red_exit_sensor_active=True) == TrafficState.RED


def test_return_red_trigger_preempts_with_four_seconds_remaining():
    sm = StateMachine({"red_duration_s":5,"red_clear_delay_s":1,"return_yellow_s":5,"yellow_clear_delay_s":5})
    sm.state = TrafficState.RETURN
    sm.state_since = 100.0
    assert sm.update(False, True, False, 101.0, red_exit_sensor_active=True) == TrafficState.RED


def test_return_red_trigger_preempts_when_return_almost_finished():
    sm = StateMachine({"red_duration_s":5,"red_clear_delay_s":1,"return_yellow_s":5,"yellow_clear_delay_s":5})
    sm.state = TrafficState.RETURN
    sm.state_since = 100.0
    assert sm.update(False, True, False, 104.9, red_exit_sensor_active=True) == TrafficState.RED


def test_return_red_trigger_with_s1_occupied_enters_and_holds_red():
    sm = StateMachine({"red_duration_s":5,"red_clear_delay_s":1,"return_yellow_s":5,"yellow_clear_delay_s":5})
    sm.state = TrafficState.RETURN
    sm.state_since = 100.0
    assert sm.update(False, True, False, 104.9, red_exit_sensor_active=True) == TrafficState.RED
    assert sm.update(False, False, False, 120.0, red_exit_sensor_active=True) == TrafficState.RED


def test_return_red_trigger_with_fresh_clear_requires_new_clear_interval():
    sm = StateMachine({"red_duration_s":5,"red_clear_delay_s":1,"return_yellow_s":5,"yellow_clear_delay_s":5})
    sm.state = TrafficState.RETURN
    sm.state_since = 100.0
    sm.red_clear_since = 90.0
    assert sm.update(False, True, False, 104.9, red_exit_sensor_active=False) == TrafficState.RED
    assert sm.red_clear_since is None
    assert sm.update(False, False, False, 105.0, red_exit_sensor_active=False) == TrafficState.RED
    assert sm.update(False, False, False, 105.9, red_exit_sensor_active=False) == TrafficState.RED
    assert sm.update(False, False, False, 106.0, red_exit_sensor_active=False) == TrafficState.RETURN


def test_repeated_red_trigger_while_red_resets_clear_timer_and_stays_red():
    sm = StateMachine({"red_duration_s":5,"red_clear_delay_s":1,"return_yellow_s":5,"yellow_clear_delay_s":5})
    sm.update(False, True, False, 10.0, red_exit_sensor_active=True)
    sm.update(False, False, False, 11.0, red_exit_sensor_active=False)
    assert sm.red_clear_since == 11.0
    assert sm.update(False, True, False, 11.9, red_exit_sensor_active=False) == TrafficState.RED
    assert sm.red_clear_since is None


def test_yellow_trigger_while_red_cannot_override_red():
    sm = StateMachine({"red_duration_s":5,"red_clear_delay_s":1,"return_yellow_s":5,"yellow_clear_delay_s":5})
    sm.update(False, True, False, 10.0, red_exit_sensor_active=True)
    assert sm.update(True, False, True, 20.0, red_exit_sensor_active=True) == TrafficState.RED


def test_reverse_direction_is_blocked_until_clear():
    p = DirectionalPairDetector("S4", "S3", 5.0, "YELLOW")
    p.update(field_inputs(s3=True, r3=20.0), 20.0)
    r = p.update(field_inputs(s4=True, s3=True, r4=20.5, r3=20.0), 20.5)
    assert r.wrong_direction and not r.triggered
    # extra oscillation while still occupied cannot become a forward trigger
    r = p.update(field_inputs(s4=True, s3=True, r4=20.5, r3=20.8), 20.8)
    assert not r.triggered
    p.update(field_inputs(s4=False, s3=False, r4=20.5, r3=20.8), 22.0)
    p.update(field_inputs(s4=True, r4=23.0), 23.0)
    assert p.update(field_inputs(s4=True, s3=True, r4=23.0, r3=23.6), 23.6).triggered


def test_pair_timeout_rejects_too_slow_sequence():
    p = DirectionalPairDetector("S4", "S3", 5.0, "YELLOW")
    p.update(field_inputs(s4=True, r4=1.0), 1.0)
    assert not p.update(field_inputs(s4=False, s3=True, r4=1.0, r3=6.1), 6.1).triggered


def test_red_pair_timeout_rejects_too_slow_sequence():
    p = DirectionalPairDetector("S2", "S1", 5.0, "RED")
    p.update(field_inputs(s2=True, r2=1.0), 1.0)
    assert not p.update(field_inputs(s2=False, s1=True, r2=1.0, r1=6.1), 6.1).triggered


def test_s3_to_s4_rejected_for_yellow():
    p = DirectionalPairDetector("S4", "S3", 5.0, "YELLOW")
    p.update(field_inputs(s3=True, r3=1.0), 1.0)
    r = p.update(field_inputs(s3=True, s4=True, r3=1.0, r4=2.0), 2.0)
    assert r.wrong_direction
    assert not r.triggered


def test_s1_to_s2_rejected_for_red():
    p = DirectionalPairDetector("S2", "S1", 5.0, "RED")
    p.update(field_inputs(s1=True, r1=1.0), 1.0)
    r = p.update(field_inputs(s1=True, s2=True, r1=1.0, r2=2.0), 2.0)
    assert r.wrong_direction
    assert not r.triggered


def test_negative_dt_is_rejected():
    p = DirectionalPairDetector("S4", "S3", 5.0, "YELLOW")
    r = p.update(field_inputs(s4=True, s3=True, r4=20.0, r3=19.0), 20.0)
    assert r.wrong_direction
    assert not r.triggered


def test_stale_second_edge_older_than_first_is_rejected():
    p = DirectionalPairDetector("S4", "S3", 5.0, "YELLOW")
    r = p.update(field_inputs(s4=True, s3=True, r4=130.0, r3=0.77), 130.0)
    assert not r.triggered
    assert not r.wrong_direction


def test_reverse_direction_stale_timestamps_cannot_later_trigger_forward_pair():
    p = DirectionalPairDetector("S4", "S3", 5.0, "YELLOW")
    p.update(field_inputs(s3=True, r3=10.0), 10.0)
    p.update(field_inputs(s4=True, s3=True, r4=11.0, r3=10.0), 11.0)
    assert not p.update(field_inputs(s4=True, s3=True, r4=11.0, r3=11.5), 11.5).triggered
    p.update(field_inputs(s4=False, s3=False, r4=11.0, r3=11.5), 12.0)
    p.update(field_inputs(s4=True, r4=20.0), 20.0)
    assert p.update(field_inputs(s4=True, s3=True, r4=20.0, r3=21.0), 21.0).triggered


def test_offline_sensor_clears_pending_sequence():
    p = DirectionalPairDetector("S4", "S3", 5.0, "YELLOW")
    p.update(field_inputs(s4=True, r4=1.0), 1.0)
    d = field_inputs(s4=True, r4=1.0)
    d["S3"].online = False
    p.update(d, 1.2)
    d["S3"] = snap(occ=True, rising=1.4, online=True)
    assert not p.update(d, 1.4).triggered


def test_red_held_while_s1_occupied_past_old_fixed_timer():
    sm = StateMachine({"red_duration_s":5,"red_clear_delay_s":1,"return_yellow_s":5,"yellow_clear_delay_s":5})
    t=100.0; sm.state_since=t
    assert sm.update(False, True, False, t, red_exit_sensor_active=True) == TrafficState.RED
    assert sm.update(False, False, False, t+5.1, red_exit_sensor_active=True) == TrafficState.RED


def test_red_held_while_s1_occupied_for_twenty_seconds():
    sm = StateMachine({"red_duration_s":5,"red_clear_delay_s":1,"return_yellow_s":5,"yellow_clear_delay_s":5})
    t=100.0; sm.state_since=t
    assert sm.update(False, True, False, t, red_exit_sensor_active=True) == TrafficState.RED
    assert sm.update(False, False, False, t+20.0, red_exit_sensor_active=True) == TrafficState.RED


def test_red_clear_requires_continuous_one_second_before_return():
    sm = StateMachine({"red_duration_s":5,"red_clear_delay_s":1,"return_yellow_s":5,"yellow_clear_delay_s":5})
    t=100.0; sm.state_since=t
    sm.update(False, True, False, t, red_exit_sensor_active=True)
    assert sm.update(False, False, False, t+12.0, red_exit_sensor_active=False) == TrafficState.RED
    assert sm.update(False, False, False, t+12.9, red_exit_sensor_active=False) == TrafficState.RED
    assert sm.update(False, False, False, t+13.0, red_exit_sensor_active=False) == TrafficState.RETURN


def test_red_clear_timer_resets_on_s1_reoccupancy():
    sm = StateMachine({"red_duration_s":5,"red_clear_delay_s":1,"return_yellow_s":5,"yellow_clear_delay_s":5})
    t=100.0; sm.state_since=t
    sm.update(False, True, False, t, red_exit_sensor_active=True)
    assert sm.update(False, False, False, t+10.0, red_exit_sensor_active=False) == TrafficState.RED
    assert sm.update(False, False, False, t+10.6, red_exit_sensor_active=True) == TrafficState.RED
    assert sm.update(False, False, False, t+11.0, red_exit_sensor_active=False) == TrafficState.RED
    assert sm.update(False, False, False, t+11.9, red_exit_sensor_active=False) == TrafficState.RED
    assert sm.update(False, False, False, t+12.0, red_exit_sensor_active=False) == TrafficState.RETURN


def test_red_holds_when_exit_sensor_offline_unknown():
    sm = StateMachine({"red_duration_s":5,"red_clear_delay_s":1,"return_yellow_s":5,"yellow_clear_delay_s":5})
    t=100.0; sm.state_since=t
    sm.update(False, True, False, t, red_exit_sensor_active=True)
    assert sm.update(False, False, False, t+30.0, red_exit_sensor_active=True) == TrafficState.RED


def test_red_exit_sensor_fresh_occupied_holds_red():
    assert red_exit_sensor_active(s1_exit_snap(occ=True, online=True, last_valid_frame=10.0), 10.1, 0.5)


def test_red_exit_sensor_fresh_clear_can_start_timer():
    assert not red_exit_sensor_active(s1_exit_snap(occ=False, online=True, last_valid_frame=10.0), 10.1, 0.5)


def test_stale_clear_before_offline_timeout_holds_red():
    sm = StateMachine({"red_duration_s":5,"red_clear_delay_s":1,"return_yellow_s":5,"yellow_clear_delay_s":5})
    t=100.0
    sm.update(False, True, False, t, red_exit_sensor_active=True)
    clear_s1 = s1_exit_snap(occ=False, online=True, last_valid_frame=t)
    assert sm.update(False, False, False, t+0.4, red_exit_sensor_active=red_exit_sensor_active(clear_s1, t+0.4, 0.5)) == TrafficState.RED
    assert sm.update(False, False, False, t+0.9, red_exit_sensor_active=red_exit_sensor_active(clear_s1, t+0.9, 0.5)) == TrafficState.RED
    assert sm.update(False, False, False, t+1.0, red_exit_sensor_active=red_exit_sensor_active(clear_s1, t+1.0, 0.5)) == TrafficState.RED
    assert sm.update(False, False, False, t+1.5, red_exit_sensor_active=red_exit_sensor_active(clear_s1, t+1.5, 0.5)) == TrafficState.RED


def test_stale_clear_then_fresh_clear_requires_new_continuous_interval():
    sm = StateMachine({"red_duration_s":5,"red_clear_delay_s":1,"return_yellow_s":5,"yellow_clear_delay_s":5})
    t=100.0
    sm.update(False, True, False, t, red_exit_sensor_active=True)
    stale_clear = s1_exit_snap(occ=False, online=True, last_valid_frame=t)
    sm.update(False, False, False, t+0.6, red_exit_sensor_active=red_exit_sensor_active(stale_clear, t+0.6, 0.5))
    fresh_clear = s1_exit_snap(occ=False, online=True, last_valid_frame=t+1.0)
    assert sm.update(False, False, False, t+1.0, red_exit_sensor_active=red_exit_sensor_active(fresh_clear, t+1.0, 0.5)) == TrafficState.RED
    fresh_clear = s1_exit_snap(occ=False, online=True, last_valid_frame=t+1.4)
    assert sm.update(False, False, False, t+1.4, red_exit_sensor_active=red_exit_sensor_active(fresh_clear, t+1.4, 0.5)) == TrafficState.RED
    fresh_clear = s1_exit_snap(occ=False, online=True, last_valid_frame=t+1.9)
    assert sm.update(False, False, False, t+1.9, red_exit_sensor_active=red_exit_sensor_active(fresh_clear, t+1.9, 0.5)) == TrafficState.RED
    fresh_clear = s1_exit_snap(occ=False, online=True, last_valid_frame=t+2.0)
    assert sm.update(False, False, False, t+2.0, red_exit_sensor_active=red_exit_sensor_active(fresh_clear, t+2.0, 0.5)) == TrafficState.RETURN


def test_stale_clear_then_fresh_occupied_holds_red():
    sm = StateMachine({"red_duration_s":5,"red_clear_delay_s":1,"return_yellow_s":5,"yellow_clear_delay_s":5})
    t=100.0
    sm.update(False, True, False, t, red_exit_sensor_active=True)
    stale_clear = s1_exit_snap(occ=False, online=True, last_valid_frame=t)
    sm.update(False, False, False, t+0.6, red_exit_sensor_active=red_exit_sensor_active(stale_clear, t+0.6, 0.5))
    fresh_occupied = s1_exit_snap(occ=True, online=True, last_valid_frame=t+1.0)
    assert sm.update(False, False, False, t+1.0, red_exit_sensor_active=red_exit_sensor_active(fresh_occupied, t+1.0, 0.5)) == TrafficState.RED


def test_red_exit_sensor_offline_holds_red():
    assert red_exit_sensor_active(s1_exit_snap(occ=False, online=False, last_valid_frame=10.0), 10.1, 0.5)


def test_recovery_clear_waits_for_full_fresh_clear_confirmation():
    sm = StateMachine({"red_duration_s":5,"red_clear_delay_s":1,"return_yellow_s":5,"yellow_clear_delay_s":5})
    t=100.0
    sm.update(False, True, False, t, red_exit_sensor_active=True)
    recovered_clear = s1_exit_snap(occ=False, online=True, last_valid_frame=t+2.0)
    assert sm.update(False, False, False, t+2.0, red_exit_sensor_active=red_exit_sensor_active(recovered_clear, t+2.0, 0.5)) == TrafficState.RED
    recovered_clear = s1_exit_snap(occ=False, online=True, last_valid_frame=t+3.0)
    assert sm.update(False, False, False, t+3.0, red_exit_sensor_active=red_exit_sensor_active(recovered_clear, t+3.0, 0.5)) == TrafficState.RETURN


def test_recovery_occupied_holds_red():
    sm = StateMachine({"red_duration_s":5,"red_clear_delay_s":1,"return_yellow_s":5,"yellow_clear_delay_s":5})
    t=100.0
    sm.update(False, True, False, t, red_exit_sensor_active=True)
    recovered_occupied = s1_exit_snap(occ=True, online=True, last_valid_frame=t+2.0)
    assert sm.update(False, False, False, t+2.0, red_exit_sensor_active=red_exit_sensor_active(recovered_occupied, t+2.0, 0.5)) == TrafficState.RED


def test_return_fixed_then_idle_after_s1_clear_confirmed():
    sm = StateMachine({"red_duration_s":5,"red_clear_delay_s":1,"return_yellow_s":5,"yellow_clear_delay_s":5})
    t=100.0; sm.state_since=t
    sm.update(False, True, False, t, red_exit_sensor_active=True)
    sm.update(False, False, False, t+8.0, red_exit_sensor_active=False)
    assert sm.update(False, False, False, t+9.0, red_exit_sensor_active=False) == TrafficState.RETURN
    assert sm.update(False, False, False, t+13.9, red_exit_sensor_active=False) == TrafficState.RETURN
    assert sm.update(False, False, False, t+14.0, red_exit_sensor_active=False) == TrafficState.IDLE


def test_return_continues_yellow_if_active_no_green_flash():
    sm = StateMachine({"red_duration_s":5,"red_clear_delay_s":1,"return_yellow_s":5,"yellow_clear_delay_s":5})
    t=100.0; sm.state_since=t
    sm.update(False, True, False, t, red_exit_sensor_active=True)
    sm.update(False, False, False, t+5, red_exit_sensor_active=False)
    sm.update(False, False, False, t+6, red_exit_sensor_active=False)
    assert sm.update(False, False, True, t+11, red_exit_sensor_active=False) == TrafficState.YELLOW


def test_return_goes_green_if_yellow_inactive_after_s1_clear_confirmed():
    sm = StateMachine({"red_duration_s":5,"red_clear_delay_s":1,"return_yellow_s":5,"yellow_clear_delay_s":5})
    t=100.0; sm.state_since=t
    sm.update(False, True, False, t, red_exit_sensor_active=True)
    sm.update(False, False, False, t+5, red_exit_sensor_active=False)
    sm.update(False, False, False, t+6, red_exit_sensor_active=False)
    assert sm.update(False, False, False, t+11, red_exit_sensor_active=False) == TrafficState.IDLE


def test_yellow_clears_only_after_delay():
    sm = StateMachine({"red_duration_s":5,"red_clear_delay_s":1,"return_yellow_s":5,"yellow_clear_delay_s":5})
    t=10.0
    assert sm.update(True, False, True, t) == TrafficState.YELLOW
    assert sm.update(False, False, False, t+1) == TrafficState.YELLOW
    assert sm.update(False, False, False, t+5.9) == TrafficState.YELLOW
    assert sm.update(False, False, False, t+6.0) == TrafficState.IDLE
