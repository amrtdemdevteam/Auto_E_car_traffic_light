"""First-run wizard backend: burn pre-built display firmware with esptool (faked here)."""
import io
import json
import shutil
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

from trafficlight.t3.config import with_defaults
from trafficlight.web.flasher import Flasher
from trafficlight.web.server import App, make_handler
from trafficlight.web.store import Users

ROOT = Path(__file__).resolve().parents[1]
PORT = "/dev/ttyACM9"


class FakeProc:
    def __init__(self, lines, rc=0, delay=0.0):
        self.stdout = io.StringIO("".join(l + "\n" for l in lines))
        self.rc, self.delay = rc, delay

    def wait(self):
        time.sleep(self.delay)
        return self.rc

    def kill(self):
        self.rc = -9


def make_fw(root: Path, cfg, displays=(1, 2)):
    for n in displays:
        d = root / cfg["setup"]["firmware_dir"] / f"display{n}"
        d.mkdir(parents=True)
        for _, f in cfg["setup"]["files"]:
            (d / f).write_bytes(b"x")


def wait_job(fl, state="running", timeout=3):
    end = time.time() + timeout
    while time.time() < end:
        j = fl.job_status()
        if j and j["state"] != state:
            return j
        time.sleep(0.02)
    raise AssertionError("job did not finish")


@pytest.fixture()
def fl(tmp_path):
    cfg = with_defaults({"lanes": [], "sensors": {"C2": {"port": "/dev/ttyUSB0"}}})
    make_fw(tmp_path, cfg)
    calls = []

    def popen(cmd, **kw):
        calls.append(cmd)
        return FakeProc(["Connecting....", "Writing at 0x00010000... (50 %)", "Writing at 0x00020000... (100 %)"])

    f = Flasher(cfg, tmp_path / "data", popen=popen, root=tmp_path,
                ports_fn=lambda: [{"path": PORT, "label": "esp"}, {"path": "/dev/ttyUSB0", "label": "rs485"}])
    (tmp_path / "data").mkdir()
    f.calls = calls
    return f


def test_command_comes_from_config_and_firmware_status(fl, tmp_path):
    cmd = fl.command(1, PORT)
    assert cmd[:3] == ["python3", "-m", "esptool"]
    assert cmd[cmd.index("--port") + 1] == PORT and cmd[cmd.index("--chip") + 1] == "esp32s3"
    assert "write-flash" in cmd and "0x10000" in cmd
    assert cmd[-1].endswith("display1/firmware.bin")
    st = fl.firmware_status()
    assert st["1"]["ok"] and st["2"]["ok"] and not st["3"]["ok"] and "bootloader.bin" in st["3"]["missing"]


def test_sensor_ports_are_never_offered(fl):
    assert [p["path"] for p in fl.ports()] == [PORT]


def test_flash_ok_records_progress_and_persists(fl, tmp_path):
    fl.start(1, PORT)
    j = wait_job(fl)
    assert j["state"] == "ok" and j["percent"] == 100.0 and j["display"] == 1
    assert fl.state["flashed"]["1"]["port"] == PORT
    again = Flasher(fl.cfg, tmp_path / "data", root=tmp_path)           # survives a restart
    assert "1" in again.state["flashed"]


def test_flash_rejects_bad_input(fl):
    with pytest.raises(ValueError):
        fl.start(9, PORT)                                               # no such display
    with pytest.raises(ValueError, match="เฟิร์มแวร์"):
        fl.start(3, PORT)                                               # firmware missing
    with pytest.raises(ValueError, match="พอร์ต"):
        fl.start(1, "/etc/passwd")                                      # arbitrary path
    with pytest.raises(ValueError, match="พอร์ต"):
        fl.start(1, "/dev/ttyUSB0")                                     # a sensor port
    assert fl.calls == []


def test_only_one_job_at_a_time(tmp_path):
    cfg = with_defaults({"lanes": []})
    make_fw(tmp_path, cfg)
    (tmp_path / "d").mkdir()
    f = Flasher(cfg, tmp_path / "d", popen=lambda c, **k: FakeProc(["x"], delay=0.3), root=tmp_path,
                ports_fn=lambda: [{"path": PORT, "label": "e"}])
    f.start(1, PORT)
    with pytest.raises(RuntimeError):
        f.start(2, PORT)
    wait_job(f)


def test_failed_flash_reports_error_and_is_not_recorded(tmp_path):
    cfg = with_defaults({"lanes": []})
    make_fw(tmp_path, cfg)
    (tmp_path / "d").mkdir()
    f = Flasher(cfg, tmp_path / "d", popen=lambda c, **k: FakeProc(["A fatal error occurred"], rc=2), root=tmp_path,
                ports_fn=lambda: [{"path": PORT, "label": "e"}])
    f.start(1, PORT)
    j = wait_job(f)
    assert j["state"] == "error" and "BOOT" in j["message"] and f.state["flashed"] == {}


def test_missing_esptool_is_a_readable_error(tmp_path):
    cfg = with_defaults({"lanes": []})
    make_fw(tmp_path, cfg)
    (tmp_path / "d").mkdir()

    def boom(c, **k):
        raise FileNotFoundError("esptool")

    f = Flasher(cfg, tmp_path / "d", popen=boom, root=tmp_path, ports_fn=lambda: [{"path": PORT, "label": "e"}])
    f.start(1, PORT)
    j = wait_job(f)
    assert j["state"] == "error" and "esptool" in j["message"]


def test_wizard_only_when_unconfigured_and_not_done(fl):
    assert fl.status(has_lanes=False)["show_wizard"] is True
    assert fl.status(has_lanes=True)["show_wizard"] is False         # already-installed junctions never see it
    fl.mark_done()
    assert fl.status(has_lanes=False)["show_wizard"] is False


# ---------------------------------------------------------------- HTTP
@pytest.fixture()
def web(tmp_path):
    shutil.copy(ROOT / "config" / "settings.t3.example.json", tmp_path / "settings.json")
    Users(tmp_path / "users.json").set("eng", "password1", "editor")
    Users(tmp_path / "users.json").set("op", "password2", "viewer")
    cfg = with_defaults(json.loads((tmp_path / "settings.json").read_text()))
    make_fw(tmp_path, cfg)
    kw = {"popen": lambda c, **k: FakeProc(["Writing (100 %)"]), "root": tmp_path,
          "ports_fn": lambda: [{"path": PORT, "label": "esp"}]}

    class St:
        def publish_control(self, c): return True
        def snapshot(self): return {"state": {"state": "IDLE", "lanes": []}, "age_s": 0.1, "stale": False}

    app = App(tmp_path, state=St(), flash_kw=kw)
    srv = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}", app
    srv.shutdown()


def call(base, path, body=None, cookie=None):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None,
                                 method="POST" if body is not None else "GET")
    req.add_header("X-T3", "1")
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read() or b"{}"), r.headers.get("Set-Cookie")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}"), None


def login(base, u, p):
    return call(base, "/api/login", {"user": u, "password": p})[2].split(";")[0]


def test_http_roles_and_flow(web):
    base, app = web
    assert call(base, "/api/setup/status")[0] == 401
    viewer = login(base, "op", "password2")
    assert call(base, "/api/setup/status", cookie=viewer)[0] == 200
    assert call(base, "/api/setup/flash", {"display": 1, "port": PORT}, cookie=viewer)[0] == 403
    assert call(base, "/api/setup/done", {}, cookie=viewer)[0] == 403
    eng = login(base, "eng", "password1")
    code, d, _ = call(base, "/api/setup/flash", {"display": 1, "port": PORT}, cookie=eng)
    assert code == 202 and d["job"]["display"] == 1
    wait_job(app.flasher)
    st = call(base, "/api/setup/status", cookie=eng)[1]
    assert st["flashed"]["1"] and st["job"]["state"] == "ok" and st["displays"] == [1, 2, 3, 4, 5]
    assert call(base, "/api/setup/flash", {"display": 1, "port": "/dev/sda"}, cookie=eng)[0] == 400
    assert call(base, "/api/setup/done", {}, cookie=eng)[0] == 200
    assert call(base, "/api/setup/status", cookie=eng)[1]["done"] is True


def test_first_account_from_the_pi_screen(tmp_path):
    """No laptop: the very first editor account is created on the Pi's own screen (loopback only, once)."""
    shutil.copy(ROOT / "config" / "settings.t3.example.json", tmp_path / "settings.json")

    class St:
        def publish_control(self, c): return True
        def snapshot(self): return {"state": {"state": "IDLE", "lanes": []}, "age_s": 0.1, "stale": False}

    app = App(tmp_path, state=St())
    srv = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        assert call(base, "/api/me")[1]["setup_needed"] is True
        assert call(base, "/api/setup/first-user", {"user": "eng01", "password": "short"})[0] == 400
        assert call(base, "/api/setup/first-user", {"user": "bad name!", "password": "longenough1"})[0] == 400
        code, _, cookie = call(base, "/api/setup/first-user", {"user": "eng01", "password": "longenough1"})
        assert code == 200 and cookie
        me = call(base, "/api/me", cookie=cookie.split(";")[0])[1]
        assert me["user"] == "eng01" and me["role"] == "editor"
        assert call(base, "/api/setup/first-user", {"user": "x2", "password": "longenough1"})[0] == 403   # only once
    finally:
        srv.shutdown()
