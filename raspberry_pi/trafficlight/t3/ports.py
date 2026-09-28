"""Serial port discovery and a read-only probe for ports no lane uses yet.

The probe lets the web UI identify sensors during setup: the engineer covers
one sensor with a hand and the port whose distance drops is that sensor.
Ports that a configured sensor already uses are never opened here (the
SensorHub owns them); their live values come from the FilteredSensor.
"""
from __future__ import annotations

import glob
import os
import re

from loguru import logger


def discover() -> list[dict]:
    """Stable serial paths. Waveshare USB-TO-4CH-RS485 shows up as 4 ports per box."""
    out = []
    boxes: dict[str, int] = {}
    seen = set()
    for p in sorted(glob.glob("/dev/serial/by-path/*")):
        m = re.match(r"(.*usb-[0-9:.]+?)(?::\d+\.(\d+))?-port\d+$", os.path.basename(p))
        parent = m.group(1) if m else os.path.basename(p)
        boxes.setdefault(parent, len(boxes) + 1)
        chan = int(m.group(2)) + 1 if m and m.group(2) is not None else None
        label = f"USB-485 #{boxes[parent]}" + (f" · ช่อง {chan}" if chan else "")
        out.append({"path": p, "label": label})
        seen.add(os.path.realpath(p))
    for p in sorted(glob.glob("/dev/ttyUSB*")):
        if os.path.realpath(p) not in seen:
            out.append({"path": p, "label": f"{os.path.basename(p)} (ชื่อไม่คงที่)"})
    return out


class _Probe:
    def __init__(self, path: str):
        self.path = path
        self.reader = None
        self.next_open = 0.0
        self.cm: int | None = None
        self.strength: int | None = None
        self.at: float | None = None


class PortProbe:
    def __init__(self, baudrate: int = 115200, reopen_s: float = 2.0, rescan_s: float = 5.0,
                 discover_fn=discover, reader_factory=None):
        self.baud = baudrate
        self.reopen_s = reopen_s
        self.rescan_s = rescan_s
        self.discover_fn = discover_fn
        self.reader_factory = reader_factory
        self.ports: list[dict] = []
        self.probes: dict[str, _Probe] = {}
        self._next_scan = 0.0

    def _open(self, pr: _Probe, now: float) -> None:
        if pr.reader is not None or now < pr.next_open:
            return
        pr.next_open = now + self.reopen_s
        try:
            if self.reader_factory is not None:
                pr.reader = self.reader_factory(pr.path, self.baud)
            else:
                from ..sensor.tfmini import TFMiniReader
                pr.reader = TFMiniReader(pr.path, self.baud, timeout=0)
        except Exception as exc:  # noqa: BLE001
            logger.debug(f"T3 probe_open_failed port={pr.path} error={exc}")

    def update(self, now: float, busy: set[str]) -> None:
        """Read every discovered port that is not in `busy` (real paths)."""
        if now >= self._next_scan:
            self._next_scan = now + self.rescan_s
            try:
                self.ports = self.discover_fn()
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"T3 port_discover_failed {exc}")
        wanted = {p["path"] for p in self.ports if os.path.realpath(p["path"]) not in busy}
        for path in list(self.probes):
            if path not in wanted:
                self._close(self.probes.pop(path))
        for path in wanted:
            pr = self.probes.setdefault(path, _Probe(path))
            self._open(pr, now)
            if pr.reader is None:
                continue
            try:
                for frame in pr.reader.read_available():
                    pr.cm, pr.strength, pr.at = frame.distance_cm, frame.strength, now
            except Exception:  # noqa: BLE001
                self._close(pr)
                pr.next_open = now + self.reopen_s

    @staticmethod
    def _close(pr: _Probe) -> None:
        if pr.reader is not None:
            try:
                pr.reader.close()
            except Exception:  # noqa: BLE001
                pass
            pr.reader = None

    def snapshot(self, now: float, assigned: dict[str, dict]) -> list[dict]:
        """One row per discovered port. `assigned`: real path -> sensor snapshot."""
        rows = []
        for p in self.ports:
            real = os.path.realpath(p["path"])
            row = {"path": p["path"], "label": p["label"], "sensor": None,
                   "cm": None, "strength": None, "age_s": None}
            if real in assigned:
                s = assigned[real]
                row.update(sensor=s["id"], cm=s.get("distance_cm"), strength=s.get("strength"),
                           age_s=s.get("age_s"))
            else:
                pr = self.probes.get(p["path"])
                if pr is not None and pr.at is not None:
                    row.update(cm=pr.cm, strength=pr.strength, age_s=round(now - pr.at, 1))
            rows.append(row)
        return rows

    def close(self) -> None:
        for pr in self.probes.values():
            self._close(pr)
