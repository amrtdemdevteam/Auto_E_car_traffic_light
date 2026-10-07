"""T3 controller: one green lane at a time, queue driven, break-before-make.

Pure logic. Time (`now`, monotonic seconds) is always passed in, so the whole
controller can be exercised by unit tests without hardware.

Safety invariants (tests/test_t3_controller.py):
  * at most one active lane; only its display is ever commanded green
  * every green grant passes the all-red barrier (docs/T3_DESIGN.md 6.2)
  * no green while STARTING
  * a sensor fault on the active lane ends that green at once; only that lane is closed
"""
from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field

from loguru import logger

from . import frames as F
from .config import lane_kind, lane_params
from .queue import Ticket, TicketQueue
from .sensors import FilteredSensor, HandDetector, SensorEvent

IDENTIFY_S = 5.0   # how long a display shows TEST after "ทดสอบจอ"
STARTING, IDLE, SWITCHING, GREEN = "STARTING", "IDLE", "SWITCHING", "GREEN"


@dataclass
class Ack:
    epoch: str
    seq: int
    frame: str
    green: bool
    at: float
    fw: str = ""


@dataclass
class _Dirty:
    """A display that must confirm it is showing a non-green frame."""
    seq: int
    issued_at: float
    timed_out: bool = False


@dataclass
class _Service:
    lane: int
    kind: str
    started: float
    clear_since: float | None = None
    end_at: float | None = None
    served: int = 1


@dataclass
class Lane:
    id: int
    kind: str
    display: int
    name: str = ""
    sensor: str | None = None          # manual / special
    near: str | None = None            # auto
    far: str | None = None             # auto
    green_frame: str = F.GO
    p: dict = field(default_factory=dict)       # effective per-lane parameters
    reasons: set = field(default_factory=set)   # why the lane is disabled
    pending_maint: bool = False
    test_until: float = 0.0

    @property
    def sensors(self) -> list[str]:
        return [s for s in (self.near, self.far, self.sensor) if s]

    @property
    def enabled(self) -> bool:
        return not self.reasons


class T3Controller:
    def __init__(self, cfg: dict, sensors: dict[str, FilteredSensor], link, now: float,
                 wall=time.time):
        self.cfg = cfg
        self.t = cfg["timing"]
        self.sensors = sensors
        self.link = link
        self.wall = wall
        self.lanes: dict[int, Lane] = {}
        for lc in cfg["lanes"]:
            lane = Lane(
                id=lc["id"], kind=lane_kind(lc), display=lc["display"], name=lc.get("name", ""),
                sensor=lc.get("sensor"), near=lc.get("near_sensor"), far=lc.get("far_sensor"),
                green_frame=lc.get("green_frame", F.GO), p=lane_params(cfg, lc),
            )
            if not lc.get("enabled", True):
                lane.reasons.add("config_disabled")
            self.lanes[lane.id] = lane
        self.sensor_lane = {sid: lane.id for lane in self.lanes.values() for sid in lane.sensors}
        self.queue = TicketQueue(
            lane_order=[lc["id"] for lc in cfg["lanes"]],
            lane_priority={lc["id"]: lc.get("priority", 0) for lc in cfg["lanes"]},
            auto_first=bool(cfg["priority"].get("auto_first", True)),
        )
        self.hands: dict[int, HandDetector] = {
            lane.id: HandDetector(sensors[lane.sensor], lane.p)
            for lane in self.lanes.values() if lane.kind == "special" and lane.sensor in sensors
        }
        lane_displays = {lane.display for lane in self.lanes.values()}
        self.unmapped_displays = sorted(int(d) for d in cfg.get("displays", {}) if int(d) not in lane_displays)
        self.all_displays = sorted(lane_displays | set(self.unmapped_displays))

        self.state = STARTING
        self.started_at = now
        self.active_lane: int | None = None
        self.service: _Service | None = None
        self.barrier_started: float | None = None
        self.dirty: dict[int, _Dirty] = {}
        self.exit_requested = False
        self.identify_until: dict[int, float] = {}
        self.events: deque = deque(maxlen=60)
        self._frames: dict[int, tuple[str, str]] = {}
        self._first_frames = True
        self._log("เริ่มระบบควบคุม T3", "controller_start")

    # ================================================================ helpers
    def _log(self, text: str, event: str, **kv) -> None:
        extra = " ".join(f"{k}={v}" for k, v in kv.items())
        logger.info(f"T3 event={event} {extra}".rstrip())
        self.events.append({"t": self.wall(), "text": text})

    def _ack_online(self, display: int, now: float) -> bool:
        ack = self.link.last_ack(display)
        return (ack is not None and ack.epoch == self.link.epoch
                and now - ack.at <= float(self.t["display_ack_timeout_s"]))

    def lane_ok(self, lane_id: int, now: float) -> bool:
        lane = self.lanes.get(lane_id)
        return bool(lane and lane.enabled and self._ack_online(lane.display, now))

    def _disable(self, lane: Lane, reason: str, now: float, drop: bool) -> None:
        if reason in lane.reasons:
            return
        lane.reasons.add(reason)
        if drop:
            self.queue.drop_lane(lane.id, "dropped")
        if lane.id in self.hands:
            self.hands[lane.id].reset()
        self._log(f"ปิดเลน {lane.id} ({reason})", "lane_disabled", lane=lane.id, reason=reason)

    def _enable(self, lane: Lane, reason: str) -> None:
        if reason in lane.reasons:
            lane.reasons.discard(reason)
            self._log(f"เปิดเลน {lane.id} กลับ ({reason} หาย)", "lane_enabled", lane=lane.id, reason=reason)

    # ============================================================ public API
    def command(self, cmd: dict, now: float) -> str:
        """Operator commands from the web UI. Returns a short result text."""
        name = cmd.get("cmd")
        user = cmd.get("user", "?")
        lane = self.lanes.get(cmd.get("lane")) if cmd.get("lane") is not None else None
        logger.info(f"T3 event=operator_command cmd={name} lane={cmd.get('lane')} user={user}")
        if name == "maintenance" and lane:
            if cmd.get("on"):
                if self.active_lane == lane.id:
                    lane.pending_maint = True
                    return "จะปิดเลนเมื่อจบรอบไฟเขียวนี้"
                self._disable(lane, "maintenance", now, drop=True)
                return "ปิดเลนแล้ว"
            lane.pending_maint = False
            self._enable(lane, "maintenance")
            return "เปิดเลนแล้ว"
        if name == "clear_queue":
            if lane:
                n = self.queue.drop_lane(lane.id, "cleared")
            else:
                n = len(self.queue.tickets)
                for tk in list(self.queue.tickets):
                    self.queue.remove(tk, "cleared")
            self._log(f"{user} เคลียร์คิว {n} ใบ", "queue_cleared", count=n)
            return f"เคลียร์คิว {n} ใบ"
        if name == "test_display" and lane:
            if self.active_lane == lane.id or self.state == SWITCHING:
                return "ทดสอบได้เฉพาะตอนเลนนั้นไม่เขียว"
            lane.test_until = now + IDENTIFY_S
            return f"จอ B{lane.display} แสดง TEST {IDENTIFY_S:g} วินาที"
        if name == "identify":
            try:
                disp = int(cmd.get("display"))
            except (TypeError, ValueError):
                return "ไม่รู้จักจอ"
            owner = next((l for l in self.lanes.values() if l.display == disp), None)
            if owner is not None and (self.active_lane == owner.id or self.state == SWITCHING):
                return "จอนี้กำลังใช้งานอยู่ ทดสอบได้เมื่อเลนนั้นไม่เขียว"
            if owner is not None:
                owner.test_until = now + IDENTIFY_S
            else:
                self.identify_until[disp] = now + IDENTIFY_S
                if disp not in self.all_displays:
                    self.all_displays = sorted(set(self.all_displays) | {disp})
                    self.unmapped_displays = sorted(set(self.unmapped_displays) | {disp})
            return f"จอ B{disp} แสดง TEST {IDENTIFY_S:g} วินาที"
        if name in ("apply_config", "restart"):
            self.exit_requested = True
            self._log(f"{user} สั่ง{'ใช้ค่าใหม่' if name == 'apply_config' else 'รีสตาร์ต'} รอให้แยกว่าง",
                      "config_apply")
            return "จะรีสตาร์ตเมื่อแยกว่าง"
        return "ไม่รู้จักคำสั่ง"

    def can_exit(self) -> bool:
        return self.exit_requested and self.state in (STARTING, IDLE) and not self.dirty

    # ================================================================== tick
    def tick(self, now: float, events: list[SensorEvent]) -> None:
        for ev in events:
            self._on_sensor_event(ev, now)
        self._update_hands(now)
        for tk in self.queue.expire(now):
            self._log(f"ตั๋ว Auto #{tk.id} หมดอายุ (เซนเซอร์ใกล้ไม่เจอรถใน "
                      f"{self.lanes[tk.lane].p['auto_ticket_expiry_s']} s)", "ticket_expired", id=tk.id)
        self._update_display_health(now)
        if self.state != SWITCHING:
            self._barrier_clear(now)   # keep confirming displays that were green

        if self.state == STARTING:
            self._tick_starting(now)
        if self.state == GREEN:
            self._tick_green(now)
        if self.state == IDLE:
            self._tick_idle(now)
        if self.state == SWITCHING:
            self._tick_switching(now)
        self._apply_frames(now)

    # ------------------------------------------------------------ sensors
    def _on_sensor_event(self, ev: SensorEvent, now: float) -> None:
        lane = self.lanes.get(self.sensor_lane.get(ev.sensor))
        if lane is None:
            return
        reason = f"sensor:{ev.sensor}"
        if ev.kind == "offline":
            if lane.kind == "auto" and ev.sensor == lane.far:
                self._log(f"C1.2 ({ev.sensor}) เสีย เลน {lane.id} ใช้ {lane.near} แทรกคิวแทน",
                          "far_sensor_degraded", sensor=ev.sensor)
                for tk in [t for t in self.queue.for_lane(lane.id) if not t.matched]:
                    self.queue.remove(tk, "dropped")
                return
            active = self.state == GREEN and self.active_lane == lane.id
            if active and lane.kind != "special":
                self._active_lane_fault(lane, ev.sensor, now)
            self._disable(lane, reason, now, drop=True)
            return
        if ev.kind in ("recovered", "online"):
            if ev.kind == "recovered" and not (lane.kind == "auto" and ev.sensor == lane.far):
                self._log(f"เซนเซอร์ {ev.sensor} กลับมาทำงาน", "sensor_recovered", sensor=ev.sensor)
            self._enable(lane, reason)
            return
        if ev.kind != "rising" or not lane.enabled or self.state == STARTING:
            return
        if lane.kind == "manual":
            if len(self.queue.for_lane(lane.id)) < int(lane.p["manual_max_pending"]):
                self.queue.add(lane.id, "manual", now, ev.sensor)
            else:   # the same vehicle seen again (gap in the body, trailer): no second green
                logger.info(f"T3 event=ticket_ignored lane={lane.id} sensor={ev.sensor} reason=already_waiting")
        elif lane.kind == "auto" and ev.sensor == lane.far:
            self.queue.add(lane.id, "auto", now, ev.sensor, matched=False,
                           expires_at=now + float(lane.p["auto_ticket_expiry_s"]))
            self._log(f"{ev.sensor} เจอ Auto → แทรกหน้าคิว", "auto_requested")
        elif lane.kind == "auto" and ev.sensor == lane.near:
            tk = self.queue.oldest_unmatched_auto(lane.id)
            serving = self.state == GREEN and self.active_lane == lane.id
            if tk is not None:
                tk.matched = True
                logger.info(f"T3 event=ticket_matched id={tk.id} lane={lane.id}")
                if serving:
                    self.queue.remove(tk, "merged")
                    self.service.served += 1
            elif not serving:
                self.queue.add(lane.id, "auto", now, ev.sensor, matched=True)

    def _active_lane_fault(self, lane: Lane, sensor: str, now: float) -> None:
        # only this lane is affected: its green ends (all-red barrier + display ACK as usual),
        # the lane stays closed with SENSOR on its own display; the other lanes carry on
        self._end_green(now, reason="sensor_fault")
        self._log(f"เซนเซอร์ {sensor} เสียขณะเลน {lane.id} เขียว → เลนนี้หยุด เลนอื่นทำงานต่อ",
                  "active_lane_fault", lane=lane.id, sensor=sensor)

    def _update_hands(self, now: float) -> None:
        for lane_id, hand in self.hands.items():
            lane = self.lanes[lane_id]
            max_pending = int(lane.p["max_pending_per_lane"])
            can_accept = (lane.enabled and self.state != STARTING
                          and len(self.queue.for_lane(lane_id)) < max_pending)
            if hand.update(now, can_accept):
                self.queue.add(lane_id, "special", now, lane.sensor)
                self._log(f"เลน {lane_id} ค้างมือครบ → ได้ตั๋ว", "hand_ticket", lane=lane_id)

    def _update_display_health(self, now: float) -> None:
        if self.state == STARTING:
            return
        for lane in self.lanes.values():
            online = self._ack_online(lane.display, now)
            if online and "display" in lane.reasons:
                self._enable(lane, "display")
            elif not online and "display" not in lane.reasons:
                self._disable(lane, "display", now, drop=False)

    # -------------------------------------------------------------- states
    def _tick_starting(self, now: float) -> None:
        if now - self.started_at < float(self.t["startup_min_s"]):
            return
        for lane in self.lanes.values():
            for sid in lane.sensors:
                s = self.sensors.get(sid)
                if s is None or not s.online:
                    if lane.kind == "auto" and sid == lane.far:
                        self._log(f"{sid} ยังไม่มีข้อมูล เลน {lane.id} ใช้ {lane.near} แทน",
                                  "far_sensor_degraded", sensor=sid)
                        continue
                    self._disable(lane, f"sensor:{sid}", now, drop=True)
        self.state = IDLE
        # vehicles already standing on a sensor at start-up still get a ticket
        for lane in self.lanes.values():
            if not lane.enabled:
                continue
            if lane.kind == "manual" and self.sensors[lane.sensor].occupied:
                self.queue.add(lane.id, "manual", now, lane.sensor)
            elif lane.kind == "auto" and self.sensors[lane.near].occupied:
                self.queue.add(lane.id, "auto", now, lane.near, matched=True)
        self._log("ระบบพร้อม", "ready")

    def _tick_idle(self, now: float) -> None:
        if self.exit_requested:
            return
        head = self.queue.head(lambda lid: self.lane_ok(lid, now))
        if head is None:
            return
        if head.kind == "auto" and not head.matched:
            return  # hold the junction for the approaching Auto (<= ticket expiry)
        self.state = SWITCHING
        self.barrier_started = now
        self._log(f"สลับเลน → เลน {head.lane} (ทุกจอ X)", "barrier_start", lane=head.lane)

    def _barrier_clear(self, now: float) -> bool:
        """Every display must confirm a non-green frame before any lane goes green.

        A display that does not answer is handled the same way whatever it was
        showing: its own lane is closed (that display shows the fault) and the
        barrier waits timing.display_fault_timeout_s -- long enough for the
        display's command to expire so it drops out of green by itself -- then
        releases, so the other lanes keep working without anyone resetting it.
        """
        clear = True
        ack_timeout = float(self.t["display_ack_timeout_s"])
        fault_timeout = float(self.t["display_fault_timeout_s"])
        for disp, d in list(self.dirty.items()):
            ack = self.link.last_ack(disp)
            if ack is not None and ack.epoch == self.link.epoch and ack.seq >= d.seq and not ack.green:
                del self.dirty[disp]
                continue
            if not d.timed_out and now >= d.issued_at + ack_timeout:
                d.timed_out = True
                self._log(f"จอ B{disp} ไม่ยืนยัน X ภายในเวลา ปิดเลนของจอนี้",
                          "display_ack_timeout", display=disp)
                for lane in self.lanes.values():
                    if lane.display == disp:
                        self._disable(lane, "display", now, drop=False)
            if now >= d.issued_at + fault_timeout:
                if d.timed_out:
                    self._log(f"ครบเวลาเผื่อจอ B{disp} เสีย เลนอื่นทำงานต่อได้",
                              "display_fault_release", display=disp)
                del self.dirty[disp]
            else:
                clear = False
        return clear

    def _tick_switching(self, now: float) -> None:
        if now - self.barrier_started < float(self.t["switch_all_red_s"]):
            return
        if not self._barrier_clear(now):
            return
        head = self.queue.head(lambda lid: self.lane_ok(lid, now))
        if head is None or (head.kind == "auto" and not head.matched):
            self.state = IDLE
            return
        self._grant(head, now)

    def _grant(self, ticket: Ticket, now: float) -> None:
        lane = self.lanes[ticket.lane]
        assert self.active_lane is None, "one green lane at a time"
        assert not self.dirty, "green granted before every display confirmed non-green"
        self.queue.remove(ticket, "served")
        self.queue.last_served_lane = lane.id
        self.active_lane = lane.id
        self.state = GREEN
        self.service = _Service(lane.id, lane.kind, now)
        if lane.kind == "special":
            self.service.end_at = now + float(lane.p["special_green_s"])
        self._log(f"เลน {lane.id} เขียว (ตั๋ว #{ticket.id})", "green_granted",
                  lane=lane.id, ticket=ticket.id)

    def _tick_green(self, now: float) -> None:
        lane = self.lanes[self.active_lane]
        svc = self.service
        if not self._ack_online(lane.display, now):
            # the display of the green lane stopped answering: stop here
            self._end_green(now, reason="display_lost")
            return
        if lane.kind == "special":
            done = now >= svc.end_at
        else:
            sid = lane.near if lane.kind == "auto" else lane.sensor
            s = self.sensors[sid]
            if s.occupied and lane.kind != "manual":
                svc.clear_since = None            # Auto: the next car of the stream keeps the green
            elif not s.occupied and svc.clear_since is None:
                svc.clear_since = max(svc.started, s.last_clear_at or svc.started)
            hold = float(lane.p["auto_clear_s"] if lane.kind == "auto" else lane.p["manual_clear_s"])
            done = svc.clear_since is not None and now - svc.clear_since >= hold
        if not done:
            return
        if lane.pending_maint or not lane.enabled:
            self._end_green(now, reason="lane_closed")
            return
        head = self.queue.head(lambda lid: self.lane_ok(lid, now) or lid == lane.id)
        if head is not None and head.lane == lane.id and lane.kind != "manual":
            # (manual lanes never chain: one vehicle per green, all-red barrier in between)
            if head.kind == "auto" and not head.matched:
                return  # next Auto is on its way: keep green (ends if the ticket expires)
            self.queue.remove(head, "merged")
            svc.served += 1
            svc.clear_since = None if lane.kind != "special" else svc.clear_since
            if lane.kind == "special":
                svc.end_at = now + float(lane.p["special_green_s"])
            else:
                svc.started = now
            self._log(f"เลน {lane.id} เขียวต่อ (คันถัดไปของเลนเดิม)", "green_extended", lane=lane.id)
            return
        self._end_green(now, reason="done")

    def _end_green(self, now: float, reason: str) -> None:
        lane = self.lanes[self.active_lane]
        self._log(f"เลน {lane.id} จบไฟเขียว ({reason})", "green_ended", lane=lane.id, reason=reason)
        self.active_lane = None
        self.service = None
        self.state = IDLE
        if lane.pending_maint:
            lane.pending_maint = False
            self._disable(lane, "maintenance", now, drop=True)
        # the lane's display must now confirm non-green before anyone else goes
        frame, arg = self._frame_for(lane, now)
        seq = self.link.command(lane.display, frame, arg, now)
        self._frames[lane.display] = (frame, arg)
        self.dirty[lane.display] = _Dirty(seq, now)

    # -------------------------------------------------------------- frames
    def _frame_for(self, lane: Lane, now: float) -> tuple[str, str]:
        if self.state == STARTING:
            return F.START, ""
        if self.state == GREEN and self.active_lane == lane.id:
            return lane.green_frame, ""
        if "config_disabled" in lane.reasons:
            return F.CONFIG, ""
        if "maintenance" in lane.reasons:
            return F.MAINT, ""
        bad = sorted(r.split(":", 1)[1] for r in lane.reasons if r.startswith("sensor:"))
        if bad:
            return F.SENSOR, bad[0]
        if lane.test_until > now:
            return F.TEST, f"B{lane.display}"
        hand = self.hands.get(lane.id)
        if hand is not None and self.state != STARTING:
            f = hand.display_frame(now)
            if f:
                return f, ""
        if lane.kind == "special" and F.STOPHINT in self.cfg.get("frames", {}).get("enabled_reserve", []):
            return F.STOPHINT, ""
        return F.STOP, ""

    def _apply_frames(self, now: float) -> None:
        wanted: dict[int, tuple[str, str]] = {}
        for lane in self.lanes.values():
            wanted[lane.display] = self._frame_for(lane, now)
        for disp in self.unmapped_displays:
            if self.identify_until.get(disp, 0.0) > now:
                wanted[disp] = (F.TEST, f"B{disp}")
            else:
                wanted[disp] = (F.CONFIG, "")
        greens = [d for d, (f, _) in wanted.items() if F.is_green(f)]
        assert len(greens) <= 1, f"more than one green display: {greens}"
        for disp, (frame, arg) in wanted.items():
            seq = self.link.command(disp, frame, arg, now)
            if self._first_frames:
                # after (re)start any display may still show an old green until it
                # confirms our first command or its own command timeout expires
                self.dirty[disp] = _Dirty(seq, now)
            self._frames[disp] = (frame, arg)
        self._first_frames = False

    # -------------------------------------------------------------- status
    def status(self, now: float) -> dict:
        lanes = []
        for lane in self.lanes.values():
            frame, arg = self._frames.get(lane.display, (F.STOP, ""))
            ack = self.link.last_ack(lane.display)
            lanes.append({
                "id": lane.id, "name": lane.name, "type": lane.kind, "display": lane.display,
                "sensors": lane.sensors, "enabled": lane.enabled, "reasons": sorted(lane.reasons),
                "frame": frame, "arg": arg, "green": self.active_lane == lane.id,
                "tickets": len(self.queue.for_lane(lane.id)),
                "hand": self.hands[lane.id].phase if lane.id in self.hands else None,
                "display_online": self._ack_online(lane.display, now),
                "display_ack_age_s": None if ack is None else round(now - ack.at, 1),
                "display_fw": None if ack is None else ack.fw,
            })
        return {
            "state": self.state,
            "active_lane": self.active_lane,
            "exit_requested": self.exit_requested,
            "epoch": self.link.epoch,
            "lanes": lanes,
            "queue": [t.as_dict(now) for t in self.queue.ordered()],
            "sensors": [s.snapshot() for s in self.sensors.values()],
            "events": list(self.events)[-20:],
        }
