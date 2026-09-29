"""Flow summary since power-on: counters, restart-proof, web API."""
from __future__ import annotations

from trafficlight.t3.flowstats import FlowStats
from trafficlight.web.server import App
from tests.test_t3_web import call, login, web  # noqa: F401  (fixture)


def st(state="IDLE", active=None, queue=(), reasons=None):
    return {"state": state, "active_lane": active, "queue": list(queue),
            "lanes": [{"id": i, "enabled": True, "reasons": (reasons or {}).get(i, [])} for i in (1, 2)]}


def tk(i, lane, age):
    return {"id": i, "lane": lane, "age_s": age}


def run(fs, t0, seq):
    t = t0
    for s, n in seq:
        for _ in range(n):
            fs.feed(s, t)
            t += 1.0
    return t


def test_green_wait_and_allred_are_counted():
    fs = FlowStats()
    run(fs, 1000, [(st(), 2), (st(queue=[tk(1, 1, 3)]), 3), (st("SWITCHING", queue=[tk(1, 1, 6)]), 2),
                   (st("GREEN", 1), 10), (st(), 2)])
    s = fs.summary()
    l1 = s["lanes"]["1"]
    assert l1["greens"] == 1 and l1["requests"] == 1 and l1["served"] == 1 and l1["expired"] == 0
    assert 9 <= l1["green_s"] <= 11 and 9 <= l1["green_max_s"] <= 11
    assert l1["wait_avg_s"] == 6.0
    assert s["allred_s"] == 2.0 and s["total_s"] > 15
    assert s["lanes"]["2"]["greens"] == 0


def test_ticket_that_leaves_without_green_is_expired():
    fs = FlowStats()
    run(fs, 0, [(st(queue=[tk(7, 2, 5)]), 3), (st(), 3)])
    l2 = fs.summary()["lanes"]["2"]
    assert l2["requests"] == 1 and l2["expired"] == 1 and l2["served"] == 0


def test_gap_is_not_counted_and_file_survives_restart(tmp_path):
    p = tmp_path / "flow.json"
    fs = FlowStats(gap_s=5, save_s=0, path=p)
    run(fs, 0, [(st("GREEN", 1), 5)])
    fs.feed(st(), 500)                       # service was down for ~8 minutes
    assert fs.summary()["gaps"] == 1 and fs.summary()["total_s"] < 10
    fs.save(500)
    again = FlowStats(path=p)
    again.load_file()
    assert again.summary()["lanes"]["1"]["greens"] == 1 and again.summary()["gaps"] == 2
    again.reset(1.0)
    assert again.summary()["lanes"] == {} and again.summary()["total_s"] == 0


def test_faults_counted_once_per_fault_and_config_error_is_not_traffic():
    fs = FlowStats()
    run(fs, 0, [(st(reasons={1: ["sensor:C1.2"]}), 4), (st(), 2), (st(reasons={1: ["sensor:C1.2"]}), 2)])
    l1 = fs.summary()["lanes"]["1"]
    assert l1["faults"] == 2 and l1["unavailable_s"] >= 4
    before = fs.summary()["total_s"]
    run(fs, 100, [({"state": "CONFIG_ERROR", "lanes": [], "queue": []}, 5)])
    assert fs.summary()["total_s"] == before


def test_web_api_summary_and_reset_by_editor_only(web):  # noqa: F811
    base, app, state, calls, tmp = web
    viewer = login(base, "op", "password2")
    eng = login(base, "eng", "password1")
    app._flow_feed(st("GREEN", 1), 10.0)
    app._flow_feed(st("GREEN", 1), 12.0)
    code, body, _ = call(base, "/api/flow", cookie=viewer)
    assert code == 200 and body["lanes"]["1"]["greens"] == 1
    assert call(base, "/api/flow/reset", {}, cookie=viewer)[0] == 403
    code, body, _ = call(base, "/api/flow/reset", {}, cookie=eng)
    assert code == 200 and body["lanes"] == {} and not state.sent
