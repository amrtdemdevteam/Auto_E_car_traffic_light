"""DisplayLink: commands are never retained, seq grows, keep-alive repeats the seq."""
from __future__ import annotations

import json

from t3_sim import t3_config
from trafficlight.t3.display_link import DisplayLink


class FakeClient:
    def __init__(self):
        self.sent = []

    def publish(self, topic, payload, qos=0, retain=False):
        self.sent.append((topic, payload, retain))


def test_commands_not_retained_seq_and_keepalive():
    c = FakeClient()
    link = DisplayLink(t3_config(), client=c)
    s1 = link.command(2, "STOP", "", 0.0)
    assert link.command(2, "STOP", "", 0.1) == s1          # unchanged frame: no new seq
    s2 = link.command(2, "GO", "", 0.2)
    assert s2 > s1
    topic, payload, retain = c.sent[-1]
    assert topic == "factory/trafficlight/T3/display/2/cmd" and retain is False
    msg = json.loads(payload)
    assert msg == {"epoch": link.epoch, "seq": s2, "frame": "GO", "arg": "", "ttl_ms": 5000}
    n = len(c.sent)
    link.tick(0.5)
    assert len(c.sent) == n                                # not yet time to refresh
    link.tick(1.3)
    assert json.loads(c.sent[-1][1])["seq"] == s2          # keep-alive repeats seq


def test_ack_parsing():
    link = DisplayLink(t3_config(), client=FakeClient())
    link.on_ack(3, {"epoch": link.epoch, "seq": 7, "frame": "STOP", "green": False, "fw": "t3-1.0.0"}, now=5.0)
    ack = link.last_ack(3)
    assert (ack.seq, ack.green, ack.at, ack.fw) == (7, False, 5.0, "t3-1.0.0")


def test_virtual_display_answers_only_while_on_and_never_for_a_real_display():
    link = DisplayLink(t3_config(), client=FakeClient())
    s = link.command(1, "GO", "", 0.0)
    link.command(2, "STOP", "", 0.0)
    link.tick(0.1)
    assert link.last_ack(1) is None                         # off by default
    link._status[2] = "online"                              # a real display B2 is connected
    link.virtual_set(True, 0.2, 10)
    link.tick(0.3)
    ack = link.last_ack(1)
    assert (ack.epoch, ack.seq, ack.green, ack.fw) == (link.epoch, s, True, "virtual")
    assert link.last_ack(2) is None                         # the real one must answer itself
    assert link.virtual_status(0.3) == {"on": True, "left_s": 10, "displays": [1]}
    link.tick(10.5)                                         # max_s reached: ends by itself
    assert link.last_ack(1) is None and link.virtual_status(10.5)["on"] is False
    link.virtual_set(True, 11.0, 10)
    link.tick(11.1)
    link.virtual_set(False, 11.2, 10)
    assert link.last_ack(1) is None


def test_virtual_display_lets_the_real_controller_switch_with_the_same_rules():
    from t3_sim import Sim
    from trafficlight.t3 import frames as F

    sim = Sim()
    link = DisplayLink(sim.cfg, client=FakeClient())
    sim.ctrl.link = link
    link.virtual_set(True, 0.0, 600)
    orig = sim.ctrl.tick

    def tick(now, events):
        orig(now, events)
        link.tick(now)
        greens = [d for d, c in link._cmds.items() if F.is_green(c.frame)]
        assert len(greens) <= 1                             # still one green at a time

    sim.ctrl.tick = tick
    sim.ready()
    assert all(l.enabled for l in sim.ctrl.lanes.values())
    sim.on("C2")
    sim.step(3)
    assert link._cmds[2].frame == F.GO and sim.ctrl.active_lane == 2
    link.virtual_set(False, sim.now, 600)                   # displays gone again -> lanes close (E201)
    sim.step(4)
    assert sim.ctrl.active_lane is None
    assert all("display" in l.reasons for l in sim.ctrl.lanes.values())
