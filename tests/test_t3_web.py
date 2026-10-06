"""Web UI server: auth, roles, config versions, control, guards."""
from __future__ import annotations

import json
import shutil
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

from trafficlight.web.server import App, make_handler
from trafficlight.web.store import Users

ROOT = Path(__file__).resolve().parents[1]


class FakeState:
    def __init__(self):
        self.sent = []
        self.state = {"state": "IDLE", "active_lane": None, "lanes": []}

    def publish_control(self, cmd):
        self.sent.append(cmd)
        return True

    def snapshot(self):
        return {"state": self.state, "age_s": 0.1, "stale": False}


@pytest.fixture()
def web(tmp_path):
    shutil.copy(ROOT / "config" / "settings.t3.example.json", tmp_path / "settings.json")
    Users(tmp_path / "users.json").set("eng", "password1", "editor")
    Users(tmp_path / "users.json").set("op", "password2", "viewer")
    state = FakeState()
    calls = []
    app = App(tmp_path, state=state, run_cmd=lambda *a, **k: calls.append(a),
              ota_post=lambda ip, port, pw, data: (200, "OK"))
    srv = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    yield base, app, state, calls, tmp_path
    srv.shutdown()


def call(base, path, body=None, cookie=None, csrf=True, raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(base + path, data=data, method="POST" if data is not None else "GET")
    if csrf:
        req.add_header("X-T3", "1")
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read() or b"{}"), r.headers.get("Set-Cookie")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}"), None


def login(base, user, pw):
    code, _, cookie = call(base, "/api/login", {"user": user, "password": pw})
    assert code == 200
    return cookie.split(";")[0]


def test_login_and_roles(web):
    base, app, state, calls, _ = web
    assert call(base, "/api/state")[0] == 401
    assert call(base, "/api/login", {"user": "eng", "password": "wrong"})[0] == 401
    viewer = login(base, "op", "password2")
    assert call(base, "/api/state", cookie=viewer)[0] == 200
    cfg = call(base, "/api/config", cookie=viewer)[1]["config"]
    assert call(base, "/api/config", {"config": cfg}, cookie=viewer)[0] == 403
    assert call(base, "/api/control", {"cmd": "restart"}, cookie=viewer)[0] == 403


def test_csrf_header_required(web):
    base = web[0]
    assert call(base, "/api/login", {"user": "eng", "password": "password1"}, csrf=False)[0] == 400


def test_save_config_versions_and_rollback(web):
    base, app, state, calls, tmp = web
    eng = login(base, "eng", "password1")
    cfg = call(base, "/api/config", cookie=eng)[1]["config"]
    cfg["timing"]["special_green_s"] = 6.0
    code, body, _ = call(base, "/api/config", {"config": cfg, "note": "ทดลอง 6 s"}, cookie=eng)
    assert code == 200 and body["version"] == 2           # v1 = the config before the first save
    saved = json.loads((tmp / "settings.json").read_text(encoding="utf-8"))
    assert saved["timing"]["special_green_s"] == 6.0 and saved["_version"] == 2
    assert state.sent[-1]["cmd"] == "apply_config" and state.sent[-1]["user"] == "eng"
    vers = call(base, "/api/versions", cookie=eng)[1]["versions"]
    assert [v["version"] for v in vers] == [2, 1]
    assert any(c["key"] == "timing.special_green_s" for c in vers[0]["changes"])
    code, body, _ = call(base, "/api/rollback", {"version": 1}, cookie=eng)
    assert code == 200 and body["version"] == 3
    assert json.loads((tmp / "settings.json").read_text(encoding="utf-8"))["timing"]["special_green_s"] == 3.0


def test_invalid_config_rejected(web):
    base = web[0]
    eng = login(base, "eng", "password1")
    cfg = call(base, "/api/config", cookie=eng)[1]["config"]
    cfg["lanes"][1]["display"] = 1
    code, body, _ = call(base, "/api/config", {"config": cfg}, cookie=eng)
    assert code == 422 and any("ซ้ำ" in e for e in body["errors"])


def test_control_carries_user_and_unknown_rejected(web):
    base, app, state, *_ = web
    eng = login(base, "eng", "password1")
    assert call(base, "/api/control", {"cmd": "maintenance", "lane": 3, "on": True}, cookie=eng)[0] == 200
    assert state.sent[-1] == {"cmd": "maintenance", "lane": 3, "on": True, "user": "eng"}
    assert call(base, "/api/control", {"cmd": "apply_config"}, cookie=eng)[0] == 400


def test_reboot_waits_for_idle(web):
    base, app, state, calls, _ = web
    eng = login(base, "eng", "password1")
    state.state["active_lane"] = 2
    assert call(base, "/api/reboot", {}, cookie=eng)[0] == 409 and not calls
    state.state["active_lane"] = None
    assert call(base, "/api/reboot", {}, cookie=eng)[0] == 200
    assert calls[-1][0] == ["sudo", "-n", "/usr/bin/systemctl", "reboot"]


def test_ota_rejects_non_firmware_and_closes_lane_first(web):
    base, app, state, *_ = web
    eng = login(base, "eng", "password1")
    assert call(base, "/api/ota/3", cookie=eng, raw=b"hello")[0] == 400
    assert call(base, "/api/ota/3", cookie=eng, raw=b"\xe9" + b"\x00" * 1000)[0] == 400   # no display tag
    assert call(base, "/api/ota/3", cookie=eng, raw=b"\xe9" + b"T3-DISPLAY-ID:2;" + b"\x00" * 1000)[0] == 400
    code, body, _ = call(base, "/api/ota/3", cookie=eng, raw=b"\xe9" + b"T3-DISPLAY-ID:3;" + b"\x00" * 1000)
    assert code == 202
    time.sleep(0.3)
    assert state.sent[0] == {"cmd": "maintenance", "lane": 3, "on": True, "user": "eng"}


def test_static_and_traversal(web):
    base = web[0]
    with urllib.request.urlopen(base + "/") as r:
        assert b"app.js" in r.read()
    with urllib.request.urlopen(base + "/static/maps/T3.svg") as r:
        assert b'<svg' in r.read()
    with pytest.raises(urllib.error.HTTPError):
        urllib.request.urlopen(base + "/static/../server.py")


def test_password_rules(tmp_path):
    u = Users(tmp_path / "users.json")
    with pytest.raises(ValueError):
        u.set("a", "short", "editor")
    with pytest.raises(ValueError):
        u.set("bad name!", "longenough", "editor")
    u.set("ok", "longenough", "viewer")
    assert u.check("ok", "longenough") == "viewer" and u.check("ok", "nope") is None
    assert "longenough" not in (tmp_path / "users.json").read_text()


def test_layout_saved_by_editor_only_and_validated(web):
    base, app, state, calls, tmp = web
    viewer = login(base, "op", "password2")
    eng = login(base, "eng", "password1")
    lay = {"lanes": {"1": {"x": 0.42, "y": 0.61, "rot": 90}}}
    assert call(base, "/api/layout", lay, cookie=viewer)[0] == 403
    code, body, _ = call(base, "/api/layout", lay, cookie=eng)
    assert code == 200 and body["lanes"]["1"] == {"x": 0.42, "y": 0.61, "rot": 90}
    assert call(base, "/api/layout", cookie=viewer)[1]["lanes"]["1"]["rot"] == 90
    assert call(base, "/api/layout", {"lanes": {"1": {"x": 2, "y": 0}}}, cookie=eng)[0] == 400
    assert call(base, "/api/layout", {"lanes": {"1": {"x": 0, "y": 0, "rot": 45}}}, cookie=eng)[0] == 400
    assert not state.sent                       # moving a widget never restarts the controller


def test_map_upload_png_and_reset(web):
    base, app, state, calls, tmp = web
    eng = login(base, "eng", "password1")
    assert call(base, "/api/map", cookie=eng)[0] == 404          # default map
    assert call(base, "/api/map", cookie=eng, raw=b"not an image")[0] == 400
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
    assert call(base, "/api/map", cookie=eng, raw=png)[0] == 200
    req = urllib.request.Request(base + "/api/map", headers={"Cookie": eng})
    with urllib.request.urlopen(req) as r:
        assert r.headers["Content-Type"] == "image/png" and "default-src 'none'" in r.headers["Content-Security-Policy"]
        assert r.read() == png
    assert call(base, "/api/map/reset", {}, cookie=eng)[0] == 200
    assert call(base, "/api/map", cookie=eng)[0] == 404


def test_template_and_identify(web):
    base, app, state, *_ = web
    eng = login(base, "eng", "password1")
    tpl = call(base, "/api/template", cookie=eng)[1]
    assert len(tpl["lanes"]) == 5 and all(v["port"] == "" for v in tpl["sensors"].values())
    assert call(base, "/api/control", {"cmd": "identify", "display": 9}, cookie=eng)[0] == 400
    assert call(base, "/api/control", {"cmd": "identify", "display": 4}, cookie=eng)[0] == 200
    assert state.sent[-1]["cmd"] == "identify" and state.sent[-1]["display"] == 4


def test_new_style_lanes_accepted(web):
    base, app, state, calls, tmp = web
    eng = login(base, "eng", "password1")
    cfg = call(base, "/api/config", cookie=eng)[1]["config"]
    for lane in cfg["lanes"]:
        if lane["type"] == "special":
            lane["type"], lane["mode"] = "manual", "hand"
    cfg["lanes"][2]["params"] = {"special_green_s": 6.0}
    assert call(base, "/api/config", {"config": cfg}, cookie=eng)[0] == 200


def test_layout_scale_is_optional_and_validated(web):
    base, app, state, calls, tmp = web
    eng = login(base, "eng", "password1")
    lay = {"lanes": {"1": {"x": 0.1, "y": 0.2, "rot": 0, "scale": 1.5}, "2": {"x": 0.3, "y": 0.4, "rot": 90}}}
    code, body, _ = call(base, "/api/layout", lay, cookie=eng)
    assert code == 200 and body["lanes"]["1"]["scale"] == 1.5 and "scale" not in body["lanes"]["2"]
    for bad in (0.1, 9, "big", True):
        assert call(base, "/api/layout", {"lanes": {"1": {"x": 0, "y": 0, "rot": 0, "scale": bad}}}, cookie=eng)[0] == 400
    assert not state.sent


def test_drawing_saved_by_editor_only_and_validated(web):
    base, app, state, calls, tmp = web
    viewer = login(base, "op", "password2")
    eng = login(base, "eng", "password1")
    assert call(base, "/api/drawing", cookie=viewer)[1] == {"items": []}          # no default map
    items = [{"id": "a", "type": "road", "x": 10, "y": 20, "w": 300, "h": 90, "fill": "soft", "stroke": "line", "sw": 1.5},
             {"id": "b", "type": "line", "x1": 0, "y1": 0, "x2": 100, "y2": 0, "arrow": True, "stroke": "faint", "sw": 4},
             {"id": "c", "type": "text", "x": 5, "y": 5, "text": "เลน 1", "size": 22, "bold": True},
             {"id": "d", "type": "ellipse", "x": 50, "y": 50, "w": 30, "h": 30, "fill": "panel", "stroke": "accent", "sw": 3}]
    assert call(base, "/api/drawing", {"items": items}, cookie=viewer)[0] == 403
    code, body, _ = call(base, "/api/drawing", {"items": items}, cookie=eng)
    assert code == 200 and [i["type"] for i in body["items"]] == ["road", "line", "text", "ellipse"]
    assert call(base, "/api/drawing", cookie=viewer)[1]["items"][2]["text"] == "เลน 1"
    bad = [{"type": "script"}, {"type": "rect", "x": 0, "y": 0, "w": 5, "h": 5, "fill": "#ff0000"},
           {"type": "text", "x": 0, "y": 0, "text": "x" * 81}, {"type": "rect", "x": "a", "y": 0, "w": 5, "h": 5}]
    for it in bad:
        assert call(base, "/api/drawing", {"items": [it]}, cookie=eng)[0] == 400
    assert call(base, "/api/drawing", {"items": [{"type": "line", "x1": 0, "y1": 0, "x2": 1, "y2": 1}] * 401}, cookie=eng)[0] == 400
    assert call(base, "/api/drawing", {"items": items}, csrf=False, cookie=eng)[0] in (400, 403)
    assert not state.sent                       # drawing never touches the controller


def test_static_serves_all_ui_scripts(web):
    base = web[0]
    with urllib.request.urlopen(base + "/") as r:
        page = r.read().decode()
    for name in ("led.js", "draw.js", "diag.js", "timing.js", "vehicles.js", "app.js", "osk.js", "rotate.js"):
        assert f"/static/{name}" in page
        with urllib.request.urlopen(base + "/static/" + name) as r:
            assert r.status == 200 and len(r.read()) > 500


def test_drawing_3d_height_is_optional_and_limited(web):
    base, app, state, calls, tmp = web
    eng = login(base, "eng", "password1")
    it = {"type": "rect", "x": 0, "y": 0, "w": 50, "h": 40, "ht": 70, "z": 10}
    code, body, _ = call(base, "/api/drawing", {"items": [it, {"type": "road", "x": 0, "y": 0, "w": 9, "h": 9, "ht": 50}]}, cookie=eng)
    assert code == 200 and body["items"][0]["ht"] == 70 and body["items"][0]["z"] == 10
    assert "ht" not in body["items"][1]                       # roads stay flat
    assert call(base, "/api/drawing", {"items": [dict(it, ht=999)]}, cookie=eng)[0] == 400
    assert call(base, "/api/drawing", {"items": [dict(it, ht=-1)]}, cookie=eng)[0] == 400


def test_layout_vehicle_heading_is_optional_and_validated(web):
    base, app, state, calls, tmp = web
    eng = login(base, "eng", "password1")
    code, body, _ = call(base, "/api/layout", {"lanes": {"1": {"x": 0.1, "y": 0.2, "rot": 0, "dir": 270}, "2": {"x": 0.3, "y": 0.4, "rot": 0}}}, cookie=eng)
    assert code == 200 and body["lanes"]["1"]["dir"] == 270 and "dir" not in body["lanes"]["2"]
    for bad in (45, "up", True, 360):
        assert call(base, "/api/layout", {"lanes": {"1": {"x": 0, "y": 0, "rot": 0, "dir": bad}}}, cookie=eng)[0] == 400


def test_user_icon_set_by_editor_and_by_self_and_validated(web):
    base, app, state, calls, tmp = web
    viewer = login(base, "op", "password2")
    eng = login(base, "eng", "password1")
    assert call(base, "/api/me", cookie=viewer)[1]["icon"] == ""
    assert call(base, "/api/me/icon", {"icon": "🚜"}, cookie=viewer)[0] == 200      # anyone may set their own
    assert call(base, "/api/me", cookie=viewer)[1]["icon"] == "🚜"
    assert call(base, "/api/users", {"name": "op", "icon": "⭐"}, cookie=viewer)[0] == 403
    assert call(base, "/api/users", {"name": "op", "icon": "⭐"}, cookie=eng)[0] == 200
    assert {u["name"]: u["icon"] for u in call(base, "/api/users", cookie=eng)[1]["users"]}["op"] == "⭐"
    assert call(base, "/api/users", {"name": "new1", "password": "password3", "role": "viewer", "icon": "🦸"}, cookie=eng)[0] == 200
    for bad in ("<b>", "x" * 20, "a\nb"):
        assert call(base, "/api/me/icon", {"icon": bad}, cookie=viewer)[0] in (400, 500)


def test_user_icon_accepts_small_jpeg_data_url_only(web):
    base, app, state, calls, tmp = web
    viewer = login(base, "op", "password2")
    ok = "data:image/jpeg;base64," + "A" * 2000
    assert call(base, "/api/me/icon", {"icon": ok}, cookie=viewer)[0] == 200
    assert call(base, "/api/me", cookie=viewer)[1]["icon"] == ok
    for bad in ("data:image/svg+xml;base64,AAAA", "data:image/jpeg;base64," + "A" * 100000, "data:image/jpeg;base64,<x>"):
        assert call(base, "/api/me/icon", {"icon": bad}, cookie=viewer)[0] in (400, 500)
    assert call(base, "/api/me", cookie=viewer)[1]["icon"] == ok


def test_drawing_safety_zone_polygon_validated(web):
    base, app, state, calls, tmp = web
    eng = login(base, "eng", "password1")
    z = {"id": "z1", "type": "zone", "pts": [[10, 10], [200, 20], [210, 120], [5, 100]], "stroke": "amb", "sw": 3}
    code, body, _ = call(base, "/api/drawing", {"items": [z]}, cookie=eng)
    assert code == 200 and body["items"][0]["type"] == "zone" and len(body["items"][0]["pts"]) == 4
    assert "rot" not in body["items"][0]
    for bad in ([[0, 0], [1, 1]], [[0, 0]] * 13, [[0, 0], [1, "a"], [2, 2]], "x", [[0, 0, 0]] * 4):
        assert call(base, "/api/drawing", {"items": [dict(z, pts=bad)]}, cookie=eng)[0] == 400


def test_sim_commands_only_for_the_configured_user(web):
    base, app, state, calls, tmp = web
    Users(tmp / "users.json").set("admin", "password3", "editor")
    eng = login(base, "eng", "password1")
    adm = login(base, "admin", "password3")
    assert call(base, "/api/me", cookie=eng)[1]["sim"] is False
    assert call(base, "/api/me", cookie=adm)[1]["sim"] is True
    assert call(base, "/api/control", {"cmd": "sim", "on": True}, cookie=eng)[0] == 403
    assert call(base, "/api/control", {"cmd": "sim", "on": True}, cookie=adm)[0] == 200
    assert state.sent[-1] == {"cmd": "sim", "on": True, "user": "admin"}
    assert call(base, "/api/control", {"cmd": "sim_pulse"}, cookie=adm)[0] == 400
    assert call(base, "/api/control", {"cmd": "sim_pulse", "sensor": "C2"}, cookie=adm)[0] == 200
