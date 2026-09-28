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
