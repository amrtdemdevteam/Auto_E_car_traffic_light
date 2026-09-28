"""T3 ticket queue.

Order (docs/T3_DESIGN.md section 4.2):
  1. auto tickets first (priority.auto_first)
  2. lane priority (higher first)
  3. created_at (first come first served)
  4. exact tie -> round robin starting after the lane that had the last green
"""
from __future__ import annotations

from dataclasses import dataclass
from itertools import count

from loguru import logger


@dataclass
class Ticket:
    id: int
    lane: int
    kind: str                 # auto | manual | special
    created_at: float
    source: str
    matched: bool = True      # auto tickets from the far sensor start unmatched
    expires_at: float | None = None

    def as_dict(self, now: float) -> dict:
        return {
            "id": self.id, "lane": self.lane, "kind": self.kind, "source": self.source,
            "age_s": round(now - self.created_at, 1), "matched": self.matched,
        }


class TicketQueue:
    def __init__(self, lane_order: list[int], lane_priority: dict[int, float], auto_first: bool = True):
        self.tickets: list[Ticket] = []
        self.lane_order = list(lane_order)
        self.lane_priority = dict(lane_priority)
        self.auto_first = auto_first
        self.last_served_lane: int | None = None
        self._ids = count(1)

    def add(self, lane: int, kind: str, now: float, source: str,
            matched: bool = True, expires_at: float | None = None) -> Ticket:
        ticket = Ticket(next(self._ids), lane, kind, now, source, matched, expires_at)
        self.tickets.append(ticket)
        logger.info(f"T3 event=ticket_created id={ticket.id} lane={lane} kind={kind} "
                    f"source={source} matched={matched}")
        return ticket

    def remove(self, ticket: Ticket, reason: str) -> None:
        if ticket in self.tickets:
            self.tickets.remove(ticket)
            logger.info(f"T3 event=ticket_{reason} id={ticket.id} lane={ticket.lane}")

    def drop_lane(self, lane: int, reason: str) -> int:
        dropped = [t for t in self.tickets if t.lane == lane]
        for t in dropped:
            self.remove(t, reason)
        return len(dropped)

    def for_lane(self, lane: int) -> list[Ticket]:
        return [t for t in self.tickets if t.lane == lane]

    def oldest_unmatched_auto(self, lane: int) -> Ticket | None:
        cands = [t for t in self.tickets if t.lane == lane and t.kind == "auto" and not t.matched]
        return min(cands, key=lambda t: (t.created_at, t.id)) if cands else None

    def expire(self, now: float) -> list[Ticket]:
        gone = [t for t in self.tickets if not t.matched and t.expires_at is not None and now >= t.expires_at]
        for t in gone:
            self.remove(t, "expired")
        return gone

    def _rr_rank(self, lane: int) -> int:
        order = self.lane_order
        if lane not in order:
            return len(order)
        if self.last_served_lane not in order:
            return order.index(lane)
        start = order.index(self.last_served_lane) + 1
        return (order.index(lane) - start) % len(order)

    def ordered(self, lane_ok=lambda lane: True) -> list[Ticket]:
        cands = [t for t in self.tickets if lane_ok(t.lane)]

        def key(t: Ticket):
            auto_rank = 0 if (self.auto_first and t.kind == "auto") else 1
            return (auto_rank, -float(self.lane_priority.get(t.lane, 0)), t.created_at,
                    self._rr_rank(t.lane), t.id)
        return sorted(cands, key=key)

    def head(self, lane_ok=lambda lane: True) -> Ticket | None:
        ordered = self.ordered(lane_ok)
        return ordered[0] if ordered else None
