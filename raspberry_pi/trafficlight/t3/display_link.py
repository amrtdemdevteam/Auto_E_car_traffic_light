"""MQTT link between the T3 controller and the B1..Bn displays.

Topics (docs/T3_DESIGN.md section 10), base = <mqtt.base_topic>/<junction_id>:
  <base>/display/<n>/cmd      controller -> display   NOT retained
  <base>/display/<n>/ack      display -> controller
  <base>/display/<n>/status   display -> controller   retained, last will "offline"
  <base>/controller/status    controller -> displays  retained, last will "offline"
  <base>/control              web UI -> controller
  <base>/state                controller -> web UI (every 0.5 s)

Each controller start gets a new random `epoch`; `seq` grows with every new
frame. Displays drop commands whose seq is not newer than the last one of the
same epoch, and treat a repeated seq as a keep-alive.
"""
from __future__ import annotations

import json
import queue
import secrets
import threading
from dataclasses import dataclass

from loguru import logger

from .controller import Ack
from .frames import is_green

VIRTUAL_FW = "virtual"   # fw of an ACK made up by the admin "จอจำลอง" mode


@dataclass
class _Cmd:
    frame: str
    arg: str
    seq: int
    last_pub: float


class DisplayLink:
    def __init__(self, cfg: dict, client=None):
        m = cfg["mqtt"]
        self.base = f"{m['base_topic'].rstrip('/')}/{cfg['junction_id']}"
        self.epoch = secrets.token_hex(4)
        self.ttl_ms = int(float(cfg["timing"]["display_link_timeout_s"]) * 1000)
        self.refresh_s = float(cfg["timing"]["command_refresh_s"])
        self._seq = 0
        self._cmds: dict[int, _Cmd] = {}
        self._acks: dict[int, Ack] = {}
        self._status: dict[int, str] = {}
        self._lock = threading.Lock()
        self._control: queue.Queue = queue.Queue()
        self.connected = False
        self._clock = None  # set by runner: callable returning monotonic now
        # admin "จอจำลอง": the Pi answers the ACK of displays that are not connected,
        # so lanes can be tuned from the web UI without the LED panels. Never saved, ends by itself.
        self.virtual_until = 0.0

        if client is None:
            import paho.mqtt.client as mqtt
            client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
                                 client_id=f"t3-controller-{cfg['junction_id']}")
            client.will_set(f"{self.base}/controller/status", "offline", qos=1, retain=True)
            client.on_connect = self._on_connect
            client.on_disconnect = self._on_disconnect
            client.on_message = self._on_message
            client.connect_async(m["broker"], int(m["port"]), int(m.get("keepalive_s", 30)))
            client.loop_start()
        self.client = client
        logger.info(f"T3 event=link_start base={self.base} epoch={self.epoch}")

    # ------------------------------------------------------------- mqtt
    def _on_connect(self, client, userdata, flags, reason_code, properties):
        self.connected = reason_code == 0
        logger.info(f"T3 event=mqtt_connected rc={reason_code}")
        client.publish(f"{self.base}/controller/status", "online", qos=1, retain=True)
        client.subscribe(f"{self.base}/display/+/ack", qos=0)
        client.subscribe(f"{self.base}/display/+/status", qos=1)
        client.subscribe(f"{self.base}/control", qos=1)

    def _on_disconnect(self, client, userdata, flags, reason_code, properties):
        self.connected = False
        logger.warning(f"T3 event=mqtt_disconnected rc={reason_code}")

    def _on_message(self, client, userdata, msg):
        try:
            parts = msg.topic.split("/")
            text = msg.payload.decode("utf-8", errors="replace")
            if msg.topic == f"{self.base}/control":
                self._control.put(json.loads(text))
                return
            if len(parts) >= 3 and parts[-3] == "display":
                disp = int(parts[-2])
                if parts[-1] == "status":
                    with self._lock:
                        self._status[disp] = text
                    logger.info(f"T3 event=display_status display={disp} status={text}")
                elif parts[-1] == "ack":
                    self.on_ack(disp, json.loads(text))
        except Exception:  # noqa: BLE001
            logger.exception(f"T3 bad_message topic={msg.topic}")

    def on_ack(self, disp: int, data: dict, now: float | None = None) -> None:
        import time
        now = now if now is not None else time.monotonic()
        ack = Ack(epoch=str(data.get("epoch", "")), seq=int(data.get("seq", -1)),
                  frame=str(data.get("frame", "")), green=bool(data.get("green", False)),
                  at=now, fw=str(data.get("fw", "")))
        with self._lock:
            self._acks[disp] = ack

    # --------------------------------------------------------- controller API
    def command(self, disp: int, frame: str, arg: str, now: float) -> int:
        cur = self._cmds.get(disp)
        if cur is not None and cur.frame == frame and cur.arg == arg:
            return cur.seq
        self._seq += 1
        self._cmds[disp] = _Cmd(frame, arg, self._seq, now)
        self._publish(disp, self._cmds[disp])
        return self._seq

    def last_ack(self, disp: int) -> Ack | None:
        with self._lock:
            return self._acks.get(disp)

    # ---------------------------------------------- admin virtual displays
    def virtual_set(self, on: bool, now: float, max_s: float) -> str:
        self.virtual_until = now + float(max_s) if on else 0.0
        if not on:
            self._virtual_clear()
        logger.warning(f"T3 event=virtual_display on={bool(on)} max_s={max_s}")
        return "เปิดจอจำลอง (จอที่ไม่ได้ต่อ ตัว Pi ตอบแทน)" if on else "ปิดจอจำลอง"

    def _virtual_clear(self) -> None:
        with self._lock:
            for d in [d for d, a in self._acks.items() if a.fw == VIRTUAL_FW]:
                del self._acks[d]

    def virtual_status(self, now: float) -> dict:
        on = now < self.virtual_until
        with self._lock:
            disps = sorted(d for d, a in self._acks.items() if a.fw == VIRTUAL_FW)
        return {"on": on, "left_s": max(0, round(self.virtual_until - now)) if on else 0,
                "displays": disps if on else []}

    def _virtual_ack(self, now: float) -> None:
        if not self.virtual_until:
            return
        if now >= self.virtual_until:
            self.virtual_until = 0.0
            self._virtual_clear()
            logger.info("T3 event=virtual_display_timeout")
            return
        with self._lock:
            for disp, cmd in self._cmds.items():
                if self._status.get(disp) == "online":
                    continue            # a real display is connected: only it may answer
                self._acks[disp] = Ack(epoch=self.epoch, seq=cmd.seq, frame=cmd.frame,
                                       green=is_green(cmd.frame), at=now, fw=VIRTUAL_FW)

    def tick(self, now: float) -> None:
        self._virtual_ack(now)
        for disp, cmd in self._cmds.items():
            if now - cmd.last_pub >= self.refresh_s:
                cmd.last_pub = now
                self._publish(disp, cmd)

    def _publish(self, disp: int, cmd: _Cmd) -> None:
        payload = json.dumps({"epoch": self.epoch, "seq": cmd.seq, "frame": cmd.frame,
                              "arg": cmd.arg, "ttl_ms": self.ttl_ms}, separators=(",", ":"))
        self.client.publish(f"{self.base}/display/{disp}/cmd", payload, qos=0, retain=False)

    def pop_commands(self) -> list[dict]:
        out = []
        while True:
            try:
                out.append(self._control.get_nowait())
            except queue.Empty:
                return out

    def publish_state(self, state: dict) -> None:
        self.client.publish(f"{self.base}/state", json.dumps(state, ensure_ascii=False,
                                                            separators=(",", ":")), qos=0, retain=False)

    def publish_result(self, cmd: dict, text: str) -> None:
        self.client.publish(f"{self.base}/control/result",
                            json.dumps({"cmd": cmd, "result": text}, ensure_ascii=False), qos=0)

    def close(self) -> None:
        try:
            info = self.client.publish(f"{self.base}/controller/status", "offline", qos=1, retain=True)
            info.wait_for_publish(timeout=1.0)
            self.client.disconnect()
            self.client.loop_stop()
        except Exception:  # noqa: BLE001
            pass
