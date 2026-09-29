"""Traffic-flow summary per lane since the system was switched on (docs/T3_DESIGN.md 12.8).

Pure logic: it is fed the controller status snapshots (the same dict the web page gets) with
the time they were taken and keeps counters. It never talks to the controller, so it cannot
disturb the safety logic. Restart-proof: the counters are a plain dict (`to_dict` / `load`) that
the web service saves to a file, so a config apply (which restarts the controller) does not
reset them. A gap between two snapshots longer than `gap_s` (service or MQTT down) is not
counted as time; it only increases `gaps`.
"""
from __future__ import annotations

import json
from pathlib import Path

WAIT_BUCKETS_KEY = "waits"


def _lane_blank() -> dict:
    return {"greens": 0, "green_s": 0.0, "green_max_s": 0.0, "green_min_s": None,
            "requests": 0, "served": 0, "expired": 0, "wait_sum_s": 0.0, "wait_max_s": 0.0,
            "queue_peak": 0, "queued_s": 0.0, "unavailable_s": 0.0, "faults": 0}


class FlowStats:
    def __init__(self, gap_s: float = 5.0, save_s: float = 30.0, path: Path | None = None):
        self.gap_s, self.save_s, self.path = float(gap_s), float(save_s), path
        self.reset(0.0)
        self._last_save = 0.0

    # ------------------------------------------------------------------ state
    def reset(self, now_wall: float) -> None:
        self.since = float(now_wall)
        self.total_s = 0.0          # observed time
        self.allred_s = 0.0         # SWITCHING (all lanes red, waiting for displays)
        self.fault_s = 0.0          # FAULT_HOLD
        self.idle_s = 0.0           # nobody waiting / green
        self.gaps = 0
        self.lanes: dict[str, dict] = {}
        self._prev: dict | None = None
        self._prev_t: float | None = None
        self._green_since: float | None = None
        self._tickets: dict[int, dict] = {}     # ticket id -> {lane, age_s, seen}
        self._faulted: set[tuple] = set()

    def _lane(self, lid) -> dict:
        return self.lanes.setdefault(str(lid), _lane_blank())

    # ------------------------------------------------------------------- feed
    def feed(self, st: dict | None, now: float) -> None:
        """`st` = controller status, `now` = wall clock seconds of that snapshot."""
        if not st or not isinstance(st.get("lanes"), list):
            return
        if not self.since:
            self.since = float(now)
        dt = 0.0 if self._prev_t is None else now - self._prev_t
        if dt < 0:
            dt = 0.0
        if dt > self.gap_s:
            self.gaps += 1
            dt = 0.0
            self._end_green(self._prev_t or now)      # cannot know how it ended: close at last sight
            self._tickets.clear()
            self._prev = None
        state = st.get("state")
        if state == "CONFIG_ERROR":                    # nothing is controlled: not traffic data
            dt = 0.0
        self.total_s += dt
        if state == "SWITCHING":
            self.allred_s += dt
        elif state == "FAULT_HOLD":
            self.fault_s += dt
        elif state == "IDLE" and not st.get("queue"):
            self.idle_s += dt
        active = st.get("active_lane")
        prev_active = None if self._prev is None else self._prev.get("active_lane")
        if active != prev_active:
            if prev_active is not None:
                self._end_green(now)
            if active is not None:
                self._green_since = now
                lane = self._lane(active)
                lane["greens"] += 1
        if active is not None:
            self._lane(active)["green_s"] += dt
        # queue: waiting time is the age of a ticket when it leaves the queue
        seen = set()
        per_lane_q: dict[int, int] = {}
        for t in st.get("queue") or []:
            tid = t.get("id")
            seen.add(tid)
            per_lane_q[t.get("lane")] = per_lane_q.get(t.get("lane"), 0) + 1
            rec = self._tickets.get(tid)
            if rec is None:
                self._tickets[tid] = {"lane": t.get("lane"), "age_s": float(t.get("age_s") or 0)}
                self._lane(t.get("lane"))["requests"] += 1
            else:
                rec["age_s"] = float(t.get("age_s") or 0)
        for tid in [k for k in self._tickets if k not in seen]:
            rec = self._tickets.pop(tid)
            lane = self._lane(rec["lane"])
            if active == rec["lane"] or prev_active == rec["lane"]:
                lane["served"] += 1
                lane["wait_sum_s"] += rec["age_s"]
                lane["wait_max_s"] = max(lane["wait_max_s"], rec["age_s"])
            else:
                lane["expired"] += 1
        for lid, n in per_lane_q.items():
            lane = self._lane(lid)
            lane["queue_peak"] = max(lane["queue_peak"], n)
            lane["queued_s"] += dt
        # availability and faults
        for l in st["lanes"]:
            lane = self._lane(l.get("id"))
            reasons = l.get("reasons") or []
            if not l.get("enabled", True) or reasons:
                lane["unavailable_s"] += dt
            for r in reasons:
                if r == "maintenance":
                    continue
                key = (l.get("id"), r)
                if key not in self._faulted:
                    self._faulted.add(key)
                    lane["faults"] += 1
            self._faulted = {k for k in self._faulted if k[0] != l.get("id") or k[1] in reasons}
        self._prev, self._prev_t = st, now
        if self.path and now - self._last_save >= self.save_s:
            self.save(now)

    def _end_green(self, now: float) -> None:
        prev = None if self._prev is None else self._prev.get("active_lane")
        if prev is not None and self._green_since is not None:
            d = max(0.0, now - self._green_since)
            lane = self._lane(prev)
            lane["green_max_s"] = max(lane["green_max_s"], d)
            lane["green_min_s"] = d if lane["green_min_s"] is None else min(lane["green_min_s"], d)
        self._green_since = None

    # ---------------------------------------------------------------- outputs
    def summary(self, now: float | None = None) -> dict:
        out_lanes = {}
        hours = self.total_s / 3600.0
        green_all = sum(l["green_s"] for l in self.lanes.values())
        for lid, l in self.lanes.items():
            served = l["served"]
            out_lanes[lid] = {
                "greens": l["greens"], "green_s": round(l["green_s"], 1),
                "green_avg_s": round(l["green_s"] / l["greens"], 1) if l["greens"] else None,
                "green_min_s": None if l["green_min_s"] is None else round(l["green_min_s"], 1),
                "green_max_s": round(l["green_max_s"], 1),
                "green_share": round(l["green_s"] / self.total_s, 4) if self.total_s else 0,
                "green_of_all": round(l["green_s"] / green_all, 4) if green_all else 0,
                "requests": l["requests"], "served": served, "expired": l["expired"],
                "wait_avg_s": round(l["wait_sum_s"] / served, 1) if served else None,
                "wait_max_s": round(l["wait_max_s"], 1),
                "queue_peak": l["queue_peak"], "queued_s": round(l["queued_s"], 1),
                "unavailable_s": round(l["unavailable_s"], 1), "faults": l["faults"],
                "served_per_hour": round(served / hours, 1) if hours > 0.01 else None,
            }
        return {"since": self.since, "total_s": round(self.total_s, 1), "allred_s": round(self.allred_s, 1),
                "fault_s": round(self.fault_s, 1), "idle_s": round(self.idle_s, 1), "gaps": self.gaps,
                "lanes": out_lanes}

    def to_dict(self) -> dict:
        return {"v": 1, "since": self.since, "total_s": self.total_s, "allred_s": self.allred_s,
                "fault_s": self.fault_s, "idle_s": self.idle_s, "gaps": self.gaps, "lanes": self.lanes}

    def load(self, d: dict) -> None:
        try:
            self.since = float(d.get("since", 0))
            self.total_s = float(d.get("total_s", 0))
            self.allred_s = float(d.get("allred_s", 0))
            self.fault_s = float(d.get("fault_s", 0))
            self.idle_s = float(d.get("idle_s", 0))
            self.gaps = int(d.get("gaps", 0)) + 1          # the time the web service was off is a gap
            self.lanes = {str(k): {**_lane_blank(), **v} for k, v in (d.get("lanes") or {}).items()}
        except (TypeError, ValueError, AttributeError):
            self.reset(0.0)

    def save(self, now: float) -> None:
        self._last_save = now
        if not self.path:
            return
        tmp = Path(str(self.path) + ".tmp")
        tmp.write_text(json.dumps(self.to_dict()), encoding="utf-8")
        tmp.replace(self.path)

    def load_file(self) -> None:
        if self.path and Path(self.path).exists():
            try:
                self.load(json.loads(Path(self.path).read_text(encoding="utf-8")))
            except (OSError, ValueError):
                pass
