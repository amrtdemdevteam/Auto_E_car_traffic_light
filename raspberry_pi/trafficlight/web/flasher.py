"""First-run helper: burn a pre-built T3 display firmware into an ESP32-S3 over USB.

The Pi never compiles anything. Firmware images for each display are built once
on a development machine (tools/build_t3_firmware.*) and committed under
firmware/t3/displayN/. This module only runs esptool on those files, one display
at a time, and reports progress to the web UI.
Every number and command comes from cfg["setup"].
"""
from __future__ import annotations

import glob
import os
import re
import subprocess
import threading
import time
from pathlib import Path

from loguru import logger

from .store import _atomic_write  # noqa: F401  (shared atomic JSON writer)

ROOT = Path(__file__).resolve().parents[3]
_PCT = re.compile(r"(\d+(?:\.\d+)?)\s?%")


def default_ports() -> list[dict]:
    """Candidate USB serial ports (ESP32-S3 shows up as ttyACM or ttyUSB)."""
    by_id = {}
    for p in glob.glob("/dev/serial/by-id/*"):
        by_id[os.path.realpath(p)] = os.path.basename(p)
    out, seen = [], set()
    for pat in ("/dev/ttyACM*", "/dev/ttyUSB*"):
        for p in sorted(glob.glob(pat)):
            real = os.path.realpath(p)
            if real in seen:
                continue
            seen.add(real)
            out.append({"path": real, "label": by_id.get(real) or os.path.basename(real)})
    return out


class Flasher:
    def __init__(self, cfg: dict, data_dir: Path, popen=subprocess.Popen, ports_fn=default_ports,
                 root: Path | None = None):
        self.cfg = cfg
        self.s = cfg["setup"]
        self.path = Path(data_dir) / "setup.json"
        self.popen = popen
        self.ports_fn = ports_fn
        self.root = Path(root) if root else ROOT
        self.lock = threading.Lock()
        self.job: dict | None = None
        self.state = self._load()

    # ---------------------------------------------------------------- persistence
    def _load(self) -> dict:
        import json
        try:
            d = json.loads(self.path.read_text(encoding="utf-8"))
            return {"done": bool(d.get("done")), "flashed": dict(d.get("flashed", {}))}
        except Exception:
            return {"done": False, "flashed": {}}

    def _save(self) -> None:
        import json
        try:
            _atomic_write(self.path, json.dumps(self.state, ensure_ascii=False, indent=1))
        except Exception as e:   # never break the UI because of a status file
            logger.warning(f"SETUP could not save {self.path}: {e}")

    def mark_done(self) -> None:
        self.state["done"] = True
        self._save()

    # ---------------------------------------------------------------- queries
    def displays(self) -> list[int]:
        return list(range(1, int(self.s["display_count"]) + 1))

    def firmware_dir(self, display: int) -> Path:
        d = Path(self.s["firmware_dir"])
        base = d if d.is_absolute() else self.root / d
        return base / f"display{display}"

    def firmware_status(self) -> dict:
        out = {}
        for n in self.displays():
            d = self.firmware_dir(n)
            missing = [f for _, f in self.s["files"] if not (d / f).is_file()]
            out[str(n)] = {"ok": not missing, "missing": missing}
        return out

    def sensor_ports(self) -> set[str]:
        res = set()
        for sc in (self.cfg.get("sensors") or {}).values():
            p = sc.get("port")
            if p:
                res.add(os.path.realpath(p))
        return res

    def ports(self) -> list[dict]:
        busy = self.sensor_ports()
        return [p for p in self.ports_fn() if os.path.realpath(p["path"]) not in busy]

    def status(self, has_lanes: bool) -> dict:
        return {
            "show_wizard": not self.state["done"] and not has_lanes,
            "done": self.state["done"],
            "flashed": self.state["flashed"],
            "displays": self.displays(),
            "firmware": self.firmware_status(),
            "ports": self.ports(),
            "job": self.job_status(),
        }

    # ---------------------------------------------------------------- flashing
    def command(self, display: int, port: str) -> list[str]:
        d = self.firmware_dir(display)
        exe = list(self.s["esptool"])
        venv = self.root / ".venv" / "bin" / "python"
        if exe[0] == "python3" and venv.is_file():          # installed on the Pi: esptool lives in the app's virtualenv
            exe[0] = str(venv)
        cmd = exe + ["--chip", str(self.s["chip"]), "--port", port,
                     "--baud", str(int(self.s["baud"])), str(self.s["write_cmd"])]
        cmd += [str(a) for a in self.s["flash_args"]]
        for off, fname in self.s["files"]:
            cmd += [str(off), str(d / fname)]
        return cmd

    def start(self, display: int, port: str) -> dict:
        if display not in self.displays():
            raise ValueError(f"ไม่มีจอ {display}")
        fw = self.firmware_status()[str(display)]
        if not fw["ok"]:
            raise ValueError(f"ไม่มีไฟล์เฟิร์มแวร์จอ {display}: {', '.join(fw['missing'])}")
        if port not in {p["path"] for p in self.ports()}:
            raise ValueError("ไม่พบพอร์ตนี้ กดรีเฟรชแล้วเลือกใหม่")
        with self.lock:
            if self.job and self.job["state"] == "running":
                raise RuntimeError("กำลังลงโปรแกรมจออื่นอยู่ รอให้เสร็จก่อน")
            self.job = {"display": display, "port": port, "state": "running", "percent": 0.0,
                        "log": [], "started": time.time(), "message": "กำลังเชื่อมต่อ"}
        threading.Thread(target=self._run, args=(self.job, self.command(display, port)), daemon=True).start()
        return self.job_status()

    def _run(self, job: dict, cmd: list[str]) -> None:
        logger.info(f"SETUP flash display={job['display']} port={job['port']}")
        try:
            proc = self.popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        except Exception as e:
            job.update(state="error", message=f"เรียก esptool ไม่ได้: {e}")
            return
        deadline = time.time() + float(self.s["timeout_s"])
        timer = threading.Timer(float(self.s["timeout_s"]), lambda: proc.kill())
        timer.daemon = True
        timer.start()
        try:
            for raw in proc.stdout:
                line = raw.rstrip()
                if not line:
                    continue
                job["log"] = (job["log"] + [line])[-int(self.s["log_lines"]):]
                m = _PCT.search(line)
                if m:
                    job["percent"] = min(100.0, float(m.group(1)))
                    job["message"] = "กำลังลงโปรแกรม"
            rc = proc.wait()
        finally:
            timer.cancel()
        if rc == 0:
            job.update(state="ok", percent=100.0, message="สำเร็จ ถอดสาย USB แล้วปิด-เปิดไฟจอ")
            self.state["flashed"][str(job["display"])] = {"t": int(time.time()), "port": job["port"]}
            self._save()
        elif time.time() >= deadline:
            job.update(state="error", message="หมดเวลา กดปุ่ม BOOT ค้าง แล้วลองใหม่")
        else:
            job.update(state="error", message=f"ไม่สำเร็จ (รหัส {rc}) กดปุ่ม BOOT ค้าง เสียบสายใหม่ แล้วลองอีกครั้ง")

    def job_status(self) -> dict | None:
        j = self.job
        if not j:
            return None
        return {k: j[k] for k in ("display", "port", "state", "percent", "log", "message")}
