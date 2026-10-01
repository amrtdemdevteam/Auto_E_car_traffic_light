// T3 display firmware: ESP32-S3 (ESP-HUB75 03K26) + Mini W5500 + P5 64x32.
//
// The display only renders what the controller commands (docs/T3_DESIGN.md
// sections 9 and 10). It decides one thing on its own: when there is no fresh
// command (or the controller is offline) it stops showing green.

#include <Arduino.h>
#include <SPI.h>
#include <Ethernet.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <esp_ota_ops.h>
#include <esp_task_wdt.h>
#include <math.h>
#include <ESP32-HUB75-MatrixPanel-I2S-DMA.h>
#include "EthOTA.h"
#include "device_config.h"

// ------------------------------------------------------------------ OTA server
// The Arduino Ethernet server lacks begin(port) expected by ESP32's Server
// interface; this adapter adds it.
class OtaEthernetServer : public EthernetServer {
 public:
  explicit OtaEthernetServer(uint16_t port) : EthernetServer(port) {}
  void begin(uint16_t port = 0) override { (void)port; EthernetServer::begin(); }
};
EthOTAClass<OtaEthernetServer, EthernetClient> OtaServer;

MatrixPanel_I2S_DMA *matrix = nullptr;
EthernetClient ethClient;
PubSubClient mqtt(ethClient);
Preferences prefs;

char topicCmd[96], topicAck[96], topicStatus[96], topicCtrl[96];

// ------------------------------------------------------------------ state
String curEpoch = "";
long lastSeq = -1;
String cmdFrame = "";      // frame requested by the controller
String cmdArg = "";
bool haveCmd = false;
unsigned long lastCmdMs = 0;
unsigned long cmdTtlMs = CMD_TTL_MAX_MS;
bool controllerOffline = false;
bool otaPending = false;
bool updating = false;
unsigned long updateStartMs = 0;
unsigned long lastMqttAttempt = 0;
unsigned long lastHeartbeatLog = 0;

String shownFrame = "";
String shownArg = "";
int shownDots = -1;

// ------------------------------------------------------------------ logging
void logEvent(const char *cat, const char *fmt, ...) {
  char msg[192];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(msg, sizeof(msg), fmt, ap);
  va_end(ap);
  Serial.printf("[%08lu] %-7s | %s\n", millis(), cat, msg);
}

// ------------------------------------------------------------------ drawing
enum Col : uint8_t { C_NONE, C_R, C_G, C_Y, C_W, C_B, C_D, C_DW };
static uint8_t fb[PANEL_H][PANEL_W];

uint16_t col565(uint8_t c) {
  switch (c) {
    case C_R:  return matrix->color565(255, 0, 0);
    case C_G:  return matrix->color565(0, 210, 0);
    case C_Y:  return matrix->color565(255, 255, 0);
    case C_W:  return matrix->color565(230, 230, 220);
    case C_B:  return matrix->color565(0, 170, 255);
    case C_D:  return matrix->color565(12, 32, 40);
    case C_DW: return matrix->color565(40, 40, 36);
    default:   return 0;
  }
}

void drawPhysicalPixel(int x, int y, uint16_t color) {
  if (x < 0 || x >= PANEL_W || y < 0 || y >= PANEL_H) return;
  const int group = x / 16;
  const int dmaX = group * 32 + (x % 16) + ((((y / 8) & 1) ^ (group & 1)) * 16);
  const int dmaY = (y % 8) + ((y / 16) * 8);
  matrix->drawPixel(dmaX, dmaY, color);
}

inline void px(int x, int y, uint8_t c) {
  if (x >= 0 && x < PANEL_W && y >= 0 && y < PANEL_H) fb[y][x] = c;
}

struct Glyph { char ch; const char *bits; };
static const Glyph FONT[] = {
  {'A', "01110100011000111111100011000110001"}, {'B', "11110100011000111110100011000111110"},
  {'C', "01110100011000010000100001000101110"}, {'D', "11110100011000110001100011000111110"},
  {'E', "11111100001000011110100001000011111"}, {'F', "11111100001000011110100001000010000"},
  {'G', "01110100011000010111100011000101111"}, {'H', "10001100011000111111100011000110001"},
  {'I', "01110001000010000100001000010001110"}, {'K', "10001100101010011000101001001010001"},
  {'L', "10000100001000010000100001000011111"}, {'M', "10001110111010110101100011000110001"},
  {'N', "10001110011010110011100011000110001"}, {'O', "01110100011000110001100011000101110"},
  {'P', "11110100011000111110100001000010000"}, {'R', "11110100011000111110101001001010001"},
  {'S', "01111100001000001110000010000111110"}, {'T', "11111001000010000100001000010000100"},
  {'U', "10001100011000110001100011000101110"}, {'W', "10001100011000110101101011010101010"},
  {'0', "01110100011001110101110011000101110"}, {'1', "00100011000010000100001000010001110"},
  {'2', "01110100010000100010001000100011111"}, {'3', "11110000010000101110000010000111110"},
  {'4', "00010001100101010010111110001000010"}, {'5', "11111100001111000001000011000101110"},
  {'6', "00110010001000011110100011000101110"}, {'7', "11111000010001000100010000100001000"},
  {'8', "01110100011000101110100011000101110"}, {'9', "01110100011000101111000010001001100"},
  {'/', "00001000100001000100010000100010000"}, {'.', "00000000000000000000000000110001100"},
  {'-', "00000000000000011111000000000000000"},
};

const char *glyph(char c) {
  for (const Glyph &g : FONT) if (g.ch == c) return g.bits;
  return nullptr;
}

int textWidth(const String &s, int sc, int sp) {
  return s.length() ? s.length() * 5 * sc + (s.length() - 1) * sp : 0;
}

void text(const String &s, int x, int y, uint8_t c, int sc, int sp) {
  int cx = x;
  for (size_t i = 0; i < s.length(); i++) {
    const char *g = glyph(s[i]);
    if (g) {
      for (int r = 0; r < 7; r++)
        for (int k = 0; k < 5; k++)
          if (g[r * 5 + k] == '1')
            for (int a = 0; a < sc; a++)
              for (int b = 0; b < sc; b++) px(cx + k * sc + b, y + r * sc + a, c);
    }
    cx += 5 * sc + sp;
  }
}

void ctext(const String &s, int y, uint8_t c, int sc = 1, int x0 = 0, int w = 64, int sp = -1) {
  if (sp < 0) sp = sc;
  text(s, x0 + (w - textWidth(s, sc, sp)) / 2, y, c, sc, sp);
}

void border(int t = 1) {
  for (int x = 0; x < 64; x++) for (int i = 0; i < t; i++) { px(x, i, C_R); px(x, 31 - i, C_R); }
  for (int y = 0; y < 32; y++) for (int j = 0; j < t; j++) { px(j, y, C_R); px(63 - j, y, C_R); }
}

void twoLine(const char *a, const char *b) { border(); ctext(a, 7, C_W); ctext(b, 18, C_W); }

float angleFromUp(float dx, float dy) {  // degrees, clockwise from 12 o'clock
  float a = atan2f(dx, -dy) * 180.0f / (float)M_PI;
  return a < 0 ? a + 360.0f : a;
}

float segDist(float px_, float py_, float x1, float y1, float x2, float y2) {
  float vx = x2 - x1, vy = y2 - y1;
  float t = ((px_ - x1) * vx + (py_ - y1) * vy) / (vx * vx + vy * vy);
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  return hypotf(px_ - (x1 + t * vx), py_ - (y1 + t * vy));
}

void bigX() {
  for (int y = 0; y < 28; y++)
    for (int x = 0; x < 28; x++) {
      int d1 = x - y, d2 = x + y - 27;
      if ((d1 >= -5 && d1 <= 5) || (d2 >= -5 && d2 <= 5)) px(18 + x, 2 + y, C_R);
    }
}

void smallX() {
  for (int y = 0; y < 24; y++)
    for (int x = 0; x < 24; x++)
      if (abs(x - y) <= 3 || abs(x + y - 23) <= 3) px(4 + x, 4 + y, C_R);
}

void bigArrow() {
  for (int y = 2; y <= 15; y++) { int hw = y - 2; for (int x = 31 - hw; x <= 32 + hw; x++) px(x, y, C_G); }
  for (int y = 16; y <= 29; y++) for (int x = 28; x <= 35; x++) px(x, y, C_G);
}

void smallArrow() {
  for (int y = 3; y <= 15; y++) { int hw = y - 3; for (int x = 14 - hw; x <= 15 + hw; x++) px(x, y, C_G); }
  for (int y = 16; y <= 29; y++) for (int x = 11; x <= 18; x++) px(x, y, C_G);
}

void sideArrow(bool mirror) {
  auto p = [&](int x, int y) { px(mirror ? 63 - x : x, y, C_G); };
  for (int y = 12; y <= 19; y++) for (int x = 6; x <= 39; x++) p(x, y);
  for (int x = 40; x <= 55; x++) { int k = 55 - x; for (int y = max(1, 15 - k); y <= min(30, 16 + k); y++) p(x, y); }
}

void ring(int lit, bool dot, bool check) {
  const float cx = 15.5f, cy = 16.0f;
  for (int y = 0; y < 32; y++)
    for (int x = 0; x < 32; x++) {
      float fx = x + 0.5f, fy = y + 0.5f;
      float d = hypotf(fx - cx, fy - cy);
      if (d >= 9.3f && d < 12.6f) {
        float a = angleFromUp(fx - cx, fy - cy);
        float m = fmodf(a, 120.0f);
        if (m < 7.0f || m > 113.0f) continue;
        int k = (int)(a / 120.0f);
        px(x, y, k < lit ? C_B : C_D);
      } else if (dot && d <= 2.7f) {
        px(x, y, C_B);
      }
      if (check && (segDist(fx, fy, cx - 4.5f, cy + 0.5f, cx - 1.5f, cy + 3.8f) < 1.3f ||
                    segDist(fx, fy, cx - 1.5f, cy + 3.8f, cx + 4.8f, cy - 3.6f) < 1.3f)) {
        px(x, y, C_W);
      }
    }
}

void renderFrame(const String &f, const String &arg, int dots) {
  memset(fb, 0, sizeof(fb));
  if (f == "START") {
    border();
    const float cx = 18.0f, cy = 16.5f;
    for (int y = 0; y < 32; y++)
      for (int x = 0; x < 40; x++) {
        float fx = x + 0.5f, fy = y + 0.5f, d = hypotf(fx - cx, fy - cy), a = angleFromUp(fx - cx, fy - cy);
        if (d >= 7.0f && d < 9.6f && a > 38.0f && a < 322.0f) px(x, y, C_W);
        if (fabsf(fx - cx) < 1.3f && fy > cy - 10.5f && fy < cy - 1.0f) px(x, y, C_W);
      }
    const int xs[3] = {34, 42, 50};
    for (int i = 0; i < 3; i++)
      for (int y = 15; y < 18; y++)
        for (int x = xs[i]; x < xs[i] + 3; x++) px(x, y, i < dots ? C_W : C_DW);
  } else if (f == "REBOOT") {
    border();
    const float cx = 32.0f, cy = 16.5f;
    for (int y = 0; y < 32; y++)
      for (int x = 0; x < 64; x++) {
        float fx = x + 0.5f, fy = y + 0.5f, d = hypotf(fx - cx, fy - cy);
        if (d >= 8.0f && d < 10.6f && angleFromUp(fx - cx, fy - cy) >= 40.0f) px(x, y, C_W);
        float tx = cx + 5, ty = cy - 9.3f, bx = cx - 1;
        if (fx >= bx && fx <= tx && fabsf(fy - ty) <= 5.2f * (tx - fx) / (tx - bx)) px(x, y, C_W);
      }
  } else if (f == "LINKWAIT") {
    twoLine("LINK", "WAIT");
  } else if (f == "GO") {
    bigArrow();
  } else if (f == "HOLD") {
    ring(0, true, false); ctext("HOLD", 12, C_W, 1, 31, 33);
  } else if (f == "HAND1") {
    ring(1, true, false); text("1/3", 31, 9, C_W, 2, 1);
  } else if (f == "HAND2") {
    ring(2, true, false); text("2/3", 31, 9, C_W, 2, 1);
  } else if (f == "HANDOK") {
    ring(3, false, true); text("OK", 37, 9, C_W, 2, 2);
  } else if (f == "SENSOR") {
    border(); ctext("SENSOR", 3, C_W); ctext(arg.length() ? arg : String("?"), 12, C_W); ctext("BROKEN", 21, C_W);
  } else if (f == "LINKLOST") {
    twoLine("LINK", "LOST");
  } else if (f == "LINKOK") {
    twoLine("LINK", "OK");
  } else if (f == "CONFIG") {
    twoLine("CONFIG", "ERROR");
  } else if (f == "MAINT") {
    border();
    for (int y = 0; y < 32; y++)
      for (int x = 0; x < 30; x++) {
        float fx = x + 0.5f, fy = y + 0.5f;
        if (segDist(fx, fy, 6.5f, 25.5f, 15.5f, 16.5f) < 2.1f) px(x, y, C_W);
        float d = hypotf(fx - 19.0f, fy - 12.5f), a = angleFromUp(fx - 19.0f, fy - 12.5f);
        if (d >= 2.6f && d < 6.4f && !(a > 15.0f && a < 75.0f)) px(x, y, C_W);
      }
    ctext("LANE", 7, C_W, 1, 28, 34); ctext("OFF", 18, C_W, 1, 28, 34);
  } else if (f == "UPDATE") {
    border();
    for (int y = 4; y <= 15; y++) for (int x = 30; x <= 33; x++) px(x, y, C_W);
    for (int y = 13; y <= 21; y++) { int h = 21 - y; for (int x = 31 - h; x <= 32 + h; x++) px(x, y, C_W); }
    for (int x = 20; x <= 43; x++) { px(x, 25, C_W); px(x, 26, C_W); }
    for (int y = 20; y <= 26; y++) { px(20, y, C_W); px(21, y, C_W); px(42, y, C_W); px(43, y, C_W); }
  } else if (f == "STOPHINT") {
    bigX();
    for (int y = 18; y < 32; y++)
      for (int x = 48; x < 64; x++) {
        float d = hypotf(x + 0.5f - 56.0f, y + 0.5f - 25.0f);
        if (d < 1.6f || (d >= 3.6f && d < 5.0f)) px(x, y, C_B);
      }
  } else if (f == "TEST") {
    // F27 identify: "which display is this?" (blue, never green)
    for (int x = 0; x < 64; x++) { px(x, 0, C_B); px(x, 31, C_B); }
    for (int y = 0; y < 32; y++) { px(0, y, C_B); px(63, y, C_B); }
    ctext("TEST", 4, C_W, 2); ctext(arg, 22, C_B);
  } else if (f == "ALLSTOP") {
    border(2); bigX();
  } else if (f == "CAUTION") {
    for (int y = 2; y <= 29; y++) { int hw = (y - 2) * 15 / 27; for (int x = 31 - hw; x <= 32 + hw; x++) px(x, y, C_Y); }
  } else if (f == "LEFT") {
    sideArrow(true);
  } else if (f == "RIGHT") {
    sideArrow(false);
  } else if (f == "GO_N") {
    smallArrow(); ctext(arg.length() ? arg.substring(0, 1) : String("3"), 5, C_W, 3, 30, 34);
  } else if (f == "STOP_N") {
    smallX(); ctext(arg.length() ? arg.substring(0, 1) : String("3"), 5, C_W, 3, 30, 34);
  } else {
    bigX();  // STOP and anything unknown: never green
  }

  matrix->fillScreen(0);
  for (int y = 0; y < PANEL_H; y++)
    for (int x = 0; x < PANEL_W; x++)
      if (fb[y][x]) drawPhysicalPixel(x, y, col565(fb[y][x]));
}

bool isGreen(const String &f) { return f == "GO" || f == "LEFT" || f == "RIGHT" || f == "GO_N"; }

bool knownFrame(const String &f) {
  static const char *names[] = {"START", "REBOOT", "LINKWAIT", "STOP", "GO", "HOLD", "HAND1", "HAND2",
                                "HANDOK", "SENSOR", "LINKLOST", "CONFIG", "MAINT", "UPDATE", "LINKOK",
                                "STOPHINT", "ALLSTOP", "CAUTION", "LEFT", "RIGHT", "GO_N", "STOP_N", "TEST"};
  for (const char *n : names) if (f == n) return true;
  return false;
}

// ------------------------------------------------------------------ decision
// The only local decision: without a fresh command, never green.
void effectiveFrame(String &f, String &arg, int &dots) {
  arg = "";
  dots = 0;
  if (updating) { f = "UPDATE"; return; }
  if (!haveCmd) {
    if (mqtt.connected()) { f = "LINKWAIT"; return; }
    f = "START";
    dots = (millis() / 500) % 3 + 1;
    return;
  }
  if (!mqtt.connected() || controllerOffline || millis() - lastCmdMs > cmdTtlMs) { f = "LINKLOST"; return; }
  f = cmdFrame;
  arg = cmdArg;
}

void sendAck() {
  if (!mqtt.connected() || curEpoch.length() == 0) return;
  String f, arg; int dots;
  effectiveFrame(f, arg, dots);
  JsonDocument doc;
  doc["epoch"] = curEpoch;
  doc["seq"] = lastSeq;
  doc["frame"] = f;
  doc["green"] = isGreen(f);
  doc["fw"] = FIRMWARE_VERSION;
  doc["up_s"] = millis() / 1000;
  char buf[200];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  mqtt.publish(topicAck, (const uint8_t *)buf, n, false);
}

void render(bool force = false) {
  String f, arg; int dots;
  effectiveFrame(f, arg, dots);
  if (!force && f == shownFrame && arg == shownArg && dots == shownDots) return;
  bool wasGreen = isGreen(shownFrame);
  renderFrame(f, arg, dots);
  if (f != shownFrame) logEvent("DISPLAY", "frame %s %s", f.c_str(), arg.c_str());
  shownFrame = f; shownArg = arg; shownDots = dots;
  if (wasGreen && !isGreen(f)) sendAck();  // e.g. timed out to LINK LOST
}

// ------------------------------------------------------------------ MQTT
void onCommand(const JsonDocument &doc) {
  String epoch = doc["epoch"] | "";
  long seq = doc["seq"] | -1L;
  String frame = doc["frame"] | "";
  String arg = doc["arg"] | "";
  unsigned long ttl = doc["ttl_ms"] | (unsigned long)CMD_TTL_MAX_MS;
  if (epoch.length() == 0 || seq < 0) return;

  if (epoch != curEpoch) {                 // controller (re)started: new session
    logEvent("MQTT", "new epoch %s", epoch.c_str());
    curEpoch = epoch;
    lastSeq = -1;
  }
  if (seq < lastSeq) return;               // old / reordered command
  if (seq > lastSeq) {
    lastSeq = seq;
    cmdFrame = knownFrame(frame) ? frame : String("STOP");
    cmdArg = arg;
  }
  haveCmd = true;
  lastCmdMs = millis();
  cmdTtlMs = min(ttl, (unsigned long)CMD_TTL_MAX_MS);
  if (otaPending) {                        // new firmware talks to the controller: keep it
    otaPending = false;
    prefs.putBool("ota_pending", false);
    logEvent("OTA", "new firmware validated");
  }
  render();
  sendAck();
}

void mqttCallback(char *topic, byte *payload, unsigned int len) {
  if (strcmp(topic, topicCtrl) == 0) {
    String s; s.reserve(len);
    for (unsigned int i = 0; i < len; i++) s += (char)payload[i];
    controllerOffline = (s != "online");
    logEvent("MQTT", "controller %s", s.c_str());
    render();
    return;
  }
  if (strcmp(topic, topicCmd) == 0) {
    JsonDocument doc;
    if (deserializeJson(doc, payload, len)) return;
    onCommand(doc);
  }
}

void connectMqtt() {
  if (mqtt.connected() || millis() - lastMqttAttempt < 2000) return;
  lastMqttAttempt = millis();
  char cid[32];
  snprintf(cid, sizeof(cid), "t3-display-%d", DISPLAY_ID);
  if (mqtt.connect(cid, topicStatus, 1, true, "offline")) {
    mqtt.publish(topicStatus, "online", true);
    mqtt.subscribe(topicCmd, 0);
    mqtt.subscribe(topicCtrl, 1);
    logEvent("MQTT", "connected");
  }
}

// ------------------------------------------------------------------ watchdog
bool wdtOn = false;
void wdtStart() {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  esp_task_wdt_config_t c = {WDT_TIMEOUT_MS, 0, true};   // timeout_ms, idle_core_mask, trigger_panic
  if (esp_task_wdt_reconfigure(&c) != ESP_OK) esp_task_wdt_init(&c);
#else
  esp_task_wdt_init(WDT_TIMEOUT_MS / 1000, true);
#endif
  esp_task_wdt_add(NULL);
  wdtOn = true;
}

// ------------------------------------------------------------------ OTA
void otaStart() {
  if (wdtOn) {                             // the upload blocks loop(): pause the watchdog
    esp_task_wdt_delete(NULL);
    wdtOn = false;
  }
  updating = true;
  updateStartMs = millis();
  render(true);
  logEvent("OTA", "upload start");
}

void otaBeforeApply() {
  prefs.putBool("ota_pending", true);
  logEvent("OTA", "applying, rollback armed");
}

void checkRollback() {
  if (!otaPending || millis() < OTA_ROLLBACK_WINDOW_MS) return;
  otaPending = false;
  prefs.putBool("ota_pending", false);
  const esp_partition_t *prev = esp_ota_get_next_update_partition(nullptr);
  logEvent("OTA", "no valid command in %lus: rolling back", OTA_ROLLBACK_WINDOW_MS / 1000);
  if (prev && esp_ota_set_boot_partition(prev) == ESP_OK) {
    delay(100);
    ESP.restart();
  }
}

// ------------------------------------------------------------------ setup / loop
void setup() {
  Serial.begin(115200);
  delay(200);
  logEvent("BOOT", "T3 display %d fw %s", DISPLAY_ID, FIRMWARE_VERSION);

  snprintf(topicCmd, sizeof(topicCmd), MQTT_BASE "/display/%d/cmd", DISPLAY_ID);
  snprintf(topicAck, sizeof(topicAck), MQTT_BASE "/display/%d/ack", DISPLAY_ID);
  snprintf(topicStatus, sizeof(topicStatus), MQTT_BASE "/display/%d/status", DISPLAY_ID);
  snprintf(topicCtrl, sizeof(topicCtrl), MQTT_BASE "/controller/status");

  HUB75_I2S_CFG::i2s_pins pins = {42, 41, 40, 39, 38, 37, 48, 36, 45, HUB75_D_PIN, -1, 47, 14, 2};
  HUB75_I2S_CFG mx(DMA_PANEL_W, DMA_PANEL_H, PANEL_CHAIN, pins);
  matrix = new MatrixPanel_I2S_DMA(mx);
  if (!matrix->begin()) {
    logEvent("HUB75", "init FAILED");
    while (true) delay(1000);
  }
  matrix->setBrightness8(MATRIX_BRIGHTNESS);
  matrix->setRotation(0);
  render(true);                           // START: never green at boot
  wdtStart();

  prefs.begin("t3", false);
  otaPending = prefs.getBool("ota_pending", false);
  if (otaPending) logEvent("OTA", "pending validation (%lus window)", OTA_ROLLBACK_WINDOW_MS / 1000);

  pinMode(W5500_RST, OUTPUT);
  digitalWrite(W5500_RST, LOW);
  delay(10);
  digitalWrite(W5500_RST, HIGH);
  delay(200);
  SPI.begin(W5500_SCK, W5500_MISO, W5500_MOSI, W5500_CS);
  delay(100);
  Ethernet.init(W5500_CS);
  byte mac[] = {0x02, 0x54, 0x33, 0x00, 0x00, (byte)DISPLAY_ID};
  Ethernet.begin(mac, DEVICE_IP, DNS_IP, GATEWAY_IP, SUBNET_MASK);
  logEvent("ETH", "IP %u.%u.%u.%u", DEVICE_IP[0], DEVICE_IP[1], DEVICE_IP[2], DEVICE_IP[3]);

  mqtt.setServer(MQTT_IP, MQTT_PORT);
  mqtt.setCallback(mqttCallback);
  mqtt.setBufferSize(512);

  char otaName[24];
  snprintf(otaName, sizeof(otaName), "t3-display-%d", DISPLAY_ID);
  OtaServer.onStart(otaStart);
  OtaServer.beforeApply(otaBeforeApply);
  OtaServer.begin(Ethernet.localIP(), otaName, OTA_PASSWORD, InternalStorage);
}

void loop() {
  connectMqtt();
  mqtt.loop();
  OtaServer.handle();
  checkRollback();
  if (updating && millis() - updateStartMs > 60000UL) updating = false;  // upload failed
  if (!updating && !wdtOn) wdtStart();
  if (wdtOn) esp_task_wdt_reset();
  render();
  if (millis() - lastHeartbeatLog > 10000) {
    lastHeartbeatLog = millis();
    logEvent("HEART", "link=%d mqtt=%d frame=%s epoch=%s seq=%ld", Ethernet.linkStatus() == LinkON,
             mqtt.connected(), shownFrame.c_str(), curEpoch.c_str(), lastSeq);
  }
  delay(5);
}
