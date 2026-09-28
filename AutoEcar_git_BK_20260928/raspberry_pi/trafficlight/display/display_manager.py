from __future__ import annotations
import json, time
import paho.mqtt.client as mqtt
from loguru import logger

class DisplayManager:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        mc = cfg["mqtt"]
        self.base = mc["base_topic"].rstrip("/")
        self.qos = int(mc.get("qos", 1))
        self.retain = bool(mc.get("retain", True))
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"trafficlight-pi-{cfg['junction_id']}")
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect
        self.client.on_message = self._on_message
        self.connected = False
        self.display_status: dict[str, str] = {}
        self._last_payload_key = None
        self._last_publish = 0.0
        self.interval = float(cfg["display"].get("publish_interval_s", 1.0))
        self.client.will_set(f"{self.base}/controller/status", "offline", qos=1, retain=True)
        self.client.connect_async(mc["broker"], int(mc["port"]), int(mc.get("keepalive_s", 30)))
        self.client.loop_start()

    def _on_connect(self, client, userdata, flags, reason_code, properties):
        self.connected = (reason_code == 0)
        logger.info(f"MQTT connected rc={reason_code}")
        client.publish(f"{self.base}/controller/status", "online", qos=1, retain=True)
        topic = f"{self.base}/junction/{self.cfg['junction_id']}/display/+/status"
        result, mid = client.subscribe(topic, qos=1)
        logger.info(f"MQTT subscribe topic={topic} result={result} mid={mid}")

    def _on_disconnect(self, client, userdata, disconnect_flags, reason_code, properties):
        self.connected = False
        logger.warning(f"MQTT disconnected rc={reason_code}")

    def _on_message(self, client, userdata, msg):
        try:
            topic = msg.topic
            status = msg.payload.decode("utf-8", errors="replace")
            display_id = topic.split("/")[-2]
            logger.debug(f"MQTT RX topic={topic} payload={status}")
            old = self.display_status.get(display_id)
            self.display_status[display_id] = status
            if status != old:
                logger.warning(f"DISPLAY {display_id} {status.upper()}")
        except Exception:
            logger.exception("DISPLAY status_parse_error")

    def close(self):
        try:
            self.client.publish(f"{self.base}/controller/status", "offline", qos=1, retain=True)
            self.client.loop_stop()
            self.client.disconnect()
        except Exception:
            pass

    def publish(self, state: str, faults: list[str], force=False):
        now = time.monotonic()
        text = self.cfg["display"]["state_text"][state]
        fault_text = "" if not faults else "ERR:" + ",".join(faults)
        payload = {
            "junction": self.cfg["junction_id"],
            "state": state,
            "text": text,
            "color": "green" if state == "idle" else ("red" if state == "red" else "yellow"),
            "faults": faults,
            "fault_text": fault_text,
            "ts": time.time()
        }
        # Do not compare a timestamped JSON string: ts changes every loop and would defeat dedupe.
        payload_key = (state, tuple(faults), text)
        if force or payload_key != self._last_payload_key or now - self._last_publish >= self.interval:
            encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            topic = f"{self.base}/junction/{self.cfg['junction_id']}/display"
            logger.debug(f"MQTT publish topic={topic} payload={encoded}")
            info = self.client.publish(
                topic,
                encoded, qos=self.qos, retain=self.retain
            )
            self.client.publish(
                f"{self.base}/junction/{self.cfg['junction_id']}/state",
                state, qos=self.qos, retain=self.retain
            )
            if info.rc != mqtt.MQTT_ERR_SUCCESS:
                logger.warning(f"MQTT publish_failed rc={info.rc}")
            self._last_payload_key = payload_key
            self._last_publish = now
