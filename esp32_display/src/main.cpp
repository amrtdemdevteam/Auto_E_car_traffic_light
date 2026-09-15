#include <Arduino.h>
#include <SPI.h>
#include <Ethernet.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <stdarg.h>
#include <string.h>
#include <ESP32-HUB75-MatrixPanel-I2S-DMA.h>
#include <ESP32-VirtualMatrixPanel-I2S-DMA.h>
#include <esp_system.h>
#include "device_config.h"

MatrixPanel_I2S_DMA *matrix = nullptr;
VirtualMatrixPanel *scanMapper = nullptr;
EthernetClient ethClient;
PubSubClient mqtt(ethClient);

String stateText = "BOOT";
String stateColor = "yellow";
String sensorFaultText = "";

unsigned long lastMqttAttempt = 0;
unsigned long lastCommandMs = 0;
unsigned long lastHeartbeatMs = 0;

EthernetLinkStatus lastLinkStatus = Unknown;
bool lastMqttConnected = false;
String lastDrawKey = "";
String loggedTextLayouts = "";
unsigned long lastLineSweepMs = 0;
int lineSweepPhase = 0;
int lineSweepPos = 0;

char commandTopic[96];
char statusTopic[96];

constexpr bool DISPLAY_NUMBER_GRID_TEST = false;
constexpr bool DISPLAY_LINE_SWEEP_TEST = false;
constexpr bool DISPLAY_ROW_TEST = false;
constexpr bool DISPLAY_GEOMETRY_TEST = false;

static constexpr int TEXT_W = PANEL_H;
static constexpr int TEXT_H = PANEL_W;

#if HUB75_SCAN_PROBE == 0
static constexpr int DMA_PANEL_W = PANEL_W;
static constexpr int DMA_PANEL_H = PANEL_H;
#else
static constexpr int DMA_PANEL_W = PANEL_W * 2;
static constexpr int DMA_PANEL_H = PANEL_H / 2;
#endif

void logEvent(const char *category, const char *format, ...) {
  char message[192];
  va_list args;
  va_start(args, format);
  vsnprintf(message, sizeof(message), format, args);
  va_end(args);
  Serial.printf("[%08lu] %-7s | %s\n", millis(), category, message);
}

String ipToString(const IPAddress &ip) {
  char buffer[16];
  snprintf(buffer, sizeof(buffer), "%u.%u.%u.%u", ip[0], ip[1], ip[2], ip[3]);
  return String(buffer);
}

const char *hardwareStatusText(EthernetHardwareStatus status) {
  switch (status) {
    case EthernetNoHardware: return "NO_HARDWARE";
    case EthernetW5100: return "W5100";
    case EthernetW5200: return "W5200";
    case EthernetW5500: return "W5500";
    default: return "UNKNOWN";
  }
}

const char *linkStatusText(EthernetLinkStatus status) {
  switch (status) {
    case Unknown: return "UNKNOWN";
    case LinkON: return "ON";
    case LinkOFF: return "OFF";
    default: return "INVALID";
  }
}

const char *resetReasonText(esp_reset_reason_t reason) {
  switch (reason) {
    case ESP_RST_POWERON: return "POWERON";
    case ESP_RST_EXT: return "EXTERNAL";
    case ESP_RST_SW: return "SOFTWARE";
    case ESP_RST_PANIC: return "PANIC";
    case ESP_RST_INT_WDT: return "INT_WDT";
    case ESP_RST_TASK_WDT: return "TASK_WDT";
    case ESP_RST_WDT: return "WDT";
    case ESP_RST_DEEPSLEEP: return "DEEPSLEEP";
    case ESP_RST_BROWNOUT: return "BROWNOUT";
    case ESP_RST_SDIO: return "SDIO";
    default: return "UNKNOWN";
  }
}

void printBanner() {
  Serial.println();
  Serial.println("================================================");
  Serial.println(" E-CAR TRAFFIC LIGHT DISPLAY");
  Serial.printf(" Firmware : %s\n", FIRMWARE_VERSION);
  Serial.printf(" Display  : %d\n", DISPLAY_ID);
  Serial.println("================================================");
}

const uint8_t GLYPH_A[7] = {0b01110,0b10001,0b10001,0b11111,0b10001,0b10001,0b10001};
const uint8_t GLYPH_C[7] = {0b01110,0b10001,0b10000,0b10000,0b10000,0b10001,0b01110};
const uint8_t GLYPH_E[7] = {0b11111,0b10000,0b10000,0b11110,0b10000,0b10000,0b11111};
const uint8_t GLYPH_I[7] = {0b11111,0b00100,0b00100,0b00100,0b00100,0b00100,0b11111};
const uint8_t GLYPH_K[7] = {0b10001,0b10010,0b10100,0b11000,0b10100,0b10010,0b10001};
const uint8_t GLYPH_L[7] = {0b10000,0b10000,0b10000,0b10000,0b10000,0b10000,0b11111};
const uint8_t GLYPH_N[7] = {0b10001,0b11001,0b10101,0b10011,0b10001,0b10001,0b10001};
const uint8_t GLYPH_O[7] = {0b01110,0b10001,0b10001,0b10001,0b10001,0b10001,0b01110};
const uint8_t GLYPH_P[7] = {0b11110,0b10001,0b10001,0b11110,0b10000,0b10000,0b10000};
const uint8_t GLYPH_R[7] = {0b11110,0b10001,0b10001,0b11110,0b10100,0b10010,0b10001};
const uint8_t GLYPH_S[7] = {0b01111,0b10000,0b10000,0b01110,0b00001,0b00001,0b11110};
const uint8_t GLYPH_T[7] = {0b11111,0b00100,0b00100,0b00100,0b00100,0b00100,0b00100};
const uint8_t GLYPH_U[7] = {0b10001,0b10001,0b10001,0b10001,0b10001,0b10001,0b01110};
const uint8_t GLYPH_1[7] = {0b00100,0b01100,0b00100,0b00100,0b00100,0b00100,0b01110};
const uint8_t GLYPH_2[7] = {0b01110,0b10001,0b00001,0b00010,0b00100,0b01000,0b11111};
const uint8_t GLYPH_3[7] = {0b11110,0b00001,0b00001,0b01110,0b00001,0b00001,0b11110};
const uint8_t GLYPH_4[7] = {0b00010,0b00110,0b01010,0b10010,0b11111,0b00010,0b00010};
const uint8_t GLYPH_COLON[7] = {0b00000,0b00100,0b00100,0b00000,0b00100,0b00100,0b00000};

const uint8_t *getGlyph(char character) {
  switch (character) {
    case 'A': return GLYPH_A;
    case 'C': return GLYPH_C;
    case 'E': return GLYPH_E;
    case 'I': return GLYPH_I;
    case 'K': return GLYPH_K;
    case 'L': return GLYPH_L;
    case 'N': return GLYPH_N;
    case 'O': return GLYPH_O;
    case 'P': return GLYPH_P;
    case 'R': return GLYPH_R;
    case 'S': return GLYPH_S;
    case 'T': return GLYPH_T;
    case 'U': return GLYPH_U;
    case '1': return GLYPH_1;
    case '2': return GLYPH_2;
    case '3': return GLYPH_3;
    case '4': return GLYPH_4;
    case ':': return GLYPH_COLON;
    default: return nullptr;
  }
}

uint16_t displayColor(uint8_t r, uint8_t g, uint8_t b) {
  return matrix->color565(r, g, b);
}

void testDrawPixel(int x, int y, uint16_t color) {
  if (scanMapper) {
    scanMapper->drawPixel(x, y, color);
  } else {
    matrix->drawPixel(x, y, color);
  }
}

void testFillRect(int x, int y, int w, int h, uint16_t color) {
  for (int yy = y; yy < y + h; yy++) {
    for (int xx = x; xx < x + w; xx++) {
      if (xx >= 0 && xx < PANEL_W && yy >= 0 && yy < PANEL_H) {
        testDrawPixel(xx, yy, color);
      }
    }
  }
}

void clearTestScreen(uint16_t color) {
  matrix->fillScreen(color);
}

void drawMappedPixel(int x, int y, uint16_t color) {
  if (x < 0 || x >= TEXT_W || y < 0 || y >= TEXT_H) return;
  matrix->drawPixel(y, x, color);
}

void drawMappedFillRect(int x, int y, int w, int h, uint16_t color) {
  for (int yy = y; yy < y + h; yy++) {
    for (int xx = x; xx < x + w; xx++) {
      drawMappedPixel(xx, yy, color);
    }
  }
}

void drawScaledPixel(int x, int y, uint16_t color, int scale) {
  for (int yOffset = 0; yOffset < scale; yOffset++) {
    int yy = y + yOffset;
    if (yy < 0 || yy >= TEXT_H) continue;
    for (int xOffset = 0; xOffset < scale; xOffset++) {
      int xx = x + xOffset;
      if (xx < 0 || xx >= TEXT_W) continue;
      drawMappedPixel(xx, yy, color);
    }
  }
}

void drawGlyph5x7(int x, int y, char character, uint16_t color, int scale) {
  if (character == ' ') return;
  const uint8_t *glyph = getGlyph(character);
  if (!glyph) return;

  for (int row = 0; row < 7; row++) {
    for (int col = 0; col < 5; col++) {
      if (glyph[row] & (1 << (4 - col))) {
        drawScaledPixel(x + (col * scale), y + (row * scale), color, scale);
      }
    }
  }
}

int textWidth5x7(const char *text, int scale) {
  int length = strlen(text);
  if (length <= 0) return 0;
  return (length * 5 * scale) + ((length - 1) * scale);
}

void drawText5x7(int x, int y, const char *text, uint16_t color, int scale) {
  int cursorX = x;
  while (*text) {
    drawGlyph5x7(cursorX, y, *text, color, scale);
    cursorX += 6 * scale;
    text++;
  }
}

void logTextLayout(const char *text, int x, int y, int width, int height, int scale) {
  String key = "|" + String(text) + ":" + String(x) + ":" + String(y) + ":" + String(scale) + "|";
  if (loggedTextLayouts.indexOf(key) >= 0) return;
  loggedTextLayouts += key;
  logEvent("DISPLAY", "text '%s' x=%d y=%d w=%d h=%d scale=%d", text, x, y, width, height, scale);
}

void drawTrafficTextCentered(const char *text, int y, uint16_t color, int scale) {
  int width = textWidth5x7(text, scale);
  int height = 7 * scale;
  int x = (TEXT_W - width) / 2;
  if (x < 0) x = 0;
  logTextLayout(text, x, y, width, height, scale);
  drawText5x7(x, y, text, color, scale);
}

void drawCautionText(uint16_t color) {
  drawTrafficTextCentered("CA", 0, color, 2);
  drawTrafficTextCentered("UT", 16, color, 2);
  drawTrafficTextCentered("IO", 32, color, 2);
  drawTrafficTextCentered("N", 48, color, 2);
}

void drawStopText(uint16_t color) {
  drawTrafficTextCentered("ST", 16, color, 2);
  drawTrafficTextCentered("OP", 34, color, 2);
}

uint16_t stateBackground(const String &name) {
  if (name == "red") return matrix->color565(255, 0, 0);
  if (name == "yellow") return matrix->color565(255, 210, 0);
  return matrix->color565(0, 210, 0);
}

String effectiveFault() {
  if (!mqtt.connected() || (lastCommandMs && millis() - lastCommandMs > MQTT_COMMAND_TIMEOUT_MS)) return "LINK ERR";
  return sensorFaultText;
}

void drawFaultBadge(const String &fault) {
  if (!fault.length()) return;
  String text = fault;
  if (text.length() > 10) text = text.substring(0, 10);

  drawMappedFillRect(0, 56, TEXT_W, 8, matrix->color565(0, 0, 0));
  drawTrafficTextCentered(text.c_str(), 56, matrix->color565(255, 255, 255), 1);
}

void logDrawAction(const String &fault) {
  String drawKey = stateText + "|" + stateColor + "|" + fault;
  if (drawKey == lastDrawKey) return;
  lastDrawKey = drawKey;

  if (stateColor == "green" || stateText == "GO") {
    logEvent("DISPLAY", "draw GREEN state=%s color=%s", stateText.c_str(), stateColor.c_str());
  } else if (stateColor == "yellow" || stateText == "CAUTION") {
    logEvent("DISPLAY", "draw YELLOW/CAUTION state=%s color=%s", stateText.c_str(), stateColor.c_str());
  } else if (stateColor == "red" || stateText == "STOP") {
    logEvent("DISPLAY", "draw RED/STOP state=%s color=%s", stateText.c_str(), stateColor.c_str());
  } else {
    logEvent("DISPLAY", "draw FALLBACK_CAUTION state=%s color=%s", stateText.c_str(), stateColor.c_str());
  }
  if (fault.length()) logEvent("DISPLAY", "fault overlay=%s", fault.c_str());
}

void drawGeometryDiagonal(int startX, int endX, uint16_t color) {
  for (int y = 0; y < PANEL_H; y++) {
    int x = startX + ((endX - startX) * y) / (PANEL_H - 1);
    if (x >= 0 && x < PANEL_W) testDrawPixel(x, y, color);
  }
}

void drawGeometryTestPattern() {
  static bool logged = false;

  if (!logged) {
    logged = true;
    logEvent("DISPLAY", "DISPLAY_GEOMETRY_TEST active: raw 64x32 primitive pattern");
  }

  uint16_t black = displayColor(0, 0, 0);
  uint16_t white = displayColor(255, 255, 255);
  uint16_t red = displayColor(255, 0, 0);
  uint16_t green = displayColor(0, 255, 0);
  uint16_t blue = displayColor(0, 0, 255);
  uint16_t yellow = displayColor(255, 210, 0);
  uint16_t cyan = displayColor(0, 255, 255);

  clearTestScreen(black);

  testFillRect(0, 0, PANEL_W, 1, white);
  testFillRect(0, PANEL_H - 1, PANEL_W, 1, white);
  testFillRect(0, 0, 1, PANEL_H, white);
  testFillRect(PANEL_W - 1, 0, 1, PANEL_H, white);

  testFillRect(16, 0, 1, PANEL_H, white);
  testFillRect(32, 0, 1, PANEL_H, white);
  testFillRect(48, 0, 1, PANEL_H, white);
  testFillRect(0, 16, PANEL_W, 1, white);

  drawGeometryDiagonal(0, PANEL_W - 1, yellow);
  drawGeometryDiagonal(PANEL_W - 1, 0, cyan);

  testFillRect(4, 4, 6, 6, red);
  testFillRect(54, 4, 6, 6, green);
  testFillRect(4, 22, 6, 6, blue);
  testFillRect(54, 22, 6, 6, white);

  testFillRect(1, 1, 3, 3, red);
  testFillRect(60, 1, 3, 3, green);
  testFillRect(1, 28, 3, 3, blue);
  testFillRect(60, 28, 3, 3, white);
}

uint16_t rowGroupColor(int group) {
  switch (group) {
    case 0: return matrix->color565(255, 0, 0);
    case 1: return matrix->color565(0, 255, 0);
    case 2: return matrix->color565(0, 0, 255);
    case 3: return matrix->color565(255, 255, 0);
    case 4: return matrix->color565(0, 255, 255);
    case 5: return matrix->color565(255, 0, 255);
    case 6: return matrix->color565(255, 128, 0);
    case 7: return matrix->color565(255, 255, 255);
    case 8: return matrix->color565(128, 0, 0);
    case 9: return matrix->color565(0, 128, 0);
    case 10: return matrix->color565(0, 0, 128);
    case 11: return matrix->color565(128, 128, 0);
    case 12: return matrix->color565(0, 128, 128);
    case 13: return matrix->color565(128, 0, 128);
    case 14: return matrix->color565(80, 80, 255);
    default: return matrix->color565(90, 90, 90);
  }
}

void drawRowTestPattern() {
  static bool logged = false;

  if (!logged) {
    logged = true;
    logEvent("DISPLAY", "DISPLAY_ROW_TEST active: 16 row groups, 2 rows each, A/B/C/D markers");
  }

  uint16_t black = matrix->color565(0, 0, 0);
  uint16_t white = matrix->color565(255, 255, 255);

  matrix->fillScreen(black);

  for (int group = 0; group < 16; group++) {
    int y = group * 2;
    uint16_t base = rowGroupColor(group);

    matrix->fillRect(0, y, PANEL_W, 2, base);

    for (int bit = 0; bit < 4; bit++) {
      bool on = (group & (1 << bit)) != 0;
      int x = 2 + (bit * 6);
      matrix->fillRect(x, y, 4, 2, on ? white : black);
    }

    if (group >= 8) {
      matrix->fillRect(58, y, 4, 2, white);
    } else {
      matrix->fillRect(58, y, 4, 2, black);
    }
  }

  matrix->fillRect(0, 0, PANEL_W, 1, white);
  matrix->fillRect(0, PANEL_H - 1, PANEL_W, 1, white);
  matrix->fillRect(0, 0, 1, PANEL_H, white);
  matrix->fillRect(PANEL_W - 1, 0, 1, PANEL_H, white);
}

void drawLineSweepFrame() {
  uint16_t black = displayColor(0, 0, 0);
  uint16_t white = displayColor(255, 255, 255);
  uint16_t green = displayColor(0, 255, 0);
  uint16_t red = displayColor(255, 0, 0);
  uint16_t blue = displayColor(0, 0, 255);
  uint16_t yellow = displayColor(255, 210, 0);

  clearTestScreen(black);
  testFillRect(0, 0, PANEL_W, 1, white);
  testFillRect(0, PANEL_H - 1, PANEL_W, 1, white);
  testFillRect(0, 0, 1, PANEL_H, white);
  testFillRect(PANEL_W - 1, 0, 1, PANEL_H, white);

  testFillRect(2, 2, 4, 4, red);
  testFillRect(PANEL_W - 6, 2, 4, 4, green);
  testFillRect(2, PANEL_H - 6, 4, 4, blue);
  testFillRect(PANEL_W - 6, PANEL_H - 6, 4, 4, yellow);

  if (lineSweepPhase == 0) {
    testFillRect(lineSweepPos, 0, 2, PANEL_H, green);
  } else {
    testFillRect(0, lineSweepPos, PANEL_W, 2, red);
  }
}

void updateLineSweepTest() {
  static bool logged = false;

  if (!logged) {
    logged = true;
    logEvent("DISPLAY", "DISPLAY_LINE_SWEEP_TEST active: vertical x sweep then horizontal y sweep");
  }

  if (millis() - lastLineSweepMs < 90) return;
  lastLineSweepMs = millis();
  drawLineSweepFrame();

  if (lineSweepPhase == 0) {
    lineSweepPos += 2;
    if (lineSweepPos >= PANEL_W) {
      lineSweepPos = 0;
      lineSweepPhase = 1;
      logEvent("DISPLAY", "line sweep phase=HORIZONTAL_Y");
    }
  } else {
    lineSweepPos += 2;
    if (lineSweepPos >= PANEL_H) {
      lineSweepPos = 0;
      lineSweepPhase = 0;
      logEvent("DISPLAY", "line sweep phase=VERTICAL_X");
    }
  }
}

const uint8_t DIGIT_0[5] = {0b111, 0b101, 0b101, 0b101, 0b111};
const uint8_t DIGIT_1[5] = {0b010, 0b110, 0b010, 0b010, 0b111};
const uint8_t DIGIT_2[5] = {0b111, 0b001, 0b111, 0b100, 0b111};
const uint8_t DIGIT_3[5] = {0b111, 0b001, 0b111, 0b001, 0b111};
const uint8_t DIGIT_4[5] = {0b101, 0b101, 0b111, 0b001, 0b001};
const uint8_t DIGIT_5[5] = {0b111, 0b100, 0b111, 0b001, 0b111};
const uint8_t DIGIT_6[5] = {0b111, 0b100, 0b111, 0b101, 0b111};
const uint8_t DIGIT_7[5] = {0b111, 0b001, 0b010, 0b010, 0b010};
const uint8_t DIGIT_8[5] = {0b111, 0b101, 0b111, 0b101, 0b111};
const uint8_t DIGIT_9[5] = {0b111, 0b101, 0b111, 0b001, 0b111};

const uint8_t *getDigitGlyph(char digit) {
  switch (digit) {
    case '0': return DIGIT_0;
    case '1': return DIGIT_1;
    case '2': return DIGIT_2;
    case '3': return DIGIT_3;
    case '4': return DIGIT_4;
    case '5': return DIGIT_5;
    case '6': return DIGIT_6;
    case '7': return DIGIT_7;
    case '8': return DIGIT_8;
    case '9': return DIGIT_9;
    default: return nullptr;
  }
}

void drawDigit3x5(int x, int y, char digit, uint16_t color) {
  const uint8_t *glyph = getDigitGlyph(digit);
  if (!glyph) return;

  for (int row = 0; row < 5; row++) {
    for (int col = 0; col < 3; col++) {
      if (glyph[row] & (1 << (2 - col))) {
        testFillRect(x + col, y + row, 1, 1, color);
      }
    }
  }
}

void drawSmallNumber(int x, int y, int value, uint16_t color) {
  if (value < 10) {
    drawDigit3x5(x + 2, y, char('0' + value), color);
    return;
  }

  drawDigit3x5(x, y, char('0' + (value / 10)), color);
  drawDigit3x5(x + 4, y, char('0' + (value % 10)), color);
}

void drawNumberGridTest() {
  static bool logged = false;

  if (!logged) {
    logged = true;
    logEvent("DISPLAY", "DISPLAY_NUMBER_GRID_TEST active: top row 1-8 bottom row 9-16");
  }

  uint16_t black = displayColor(0, 0, 0);
  uint16_t white = displayColor(255, 255, 255);
  uint16_t yellow = displayColor(255, 210, 0);
  uint16_t red = displayColor(255, 0, 0);
  uint16_t green = displayColor(0, 255, 0);

  clearTestScreen(black);

  for (int x = 0; x <= PANEL_W; x += 8) {
    int lineX = x >= PANEL_W ? PANEL_W - 1 : x;
    testFillRect(lineX, 0, 1, PANEL_H, white);
  }
  testFillRect(0, 0, PANEL_W, 1, white);
  testFillRect(0, 15, PANEL_W, 1, white);
  testFillRect(0, PANEL_H - 1, PANEL_W, 1, white);

  for (int number = 1; number <= 16; number++) {
    int index = number - 1;
    int col = index % 8;
    int row = index / 8;
    int x = col * 8;
    int y = row == 0 ? 5 : 21;
    uint16_t color = number <= 8 ? green : yellow;
    if (number == 1 || number == 9) color = red;
    drawSmallNumber(x, y, number, color);
  }
}

// Symbol modes are opt-in; ordinary display1 keeps the original solid screen.
#ifndef DISPLAY_SYMBOL_MODE
#define DISPLAY_SYMBOL_MODE 0
#endif
#ifndef SYMBOL_BENCH_TEST
#define SYMBOL_BENCH_TEST 0
#endif
#if SYMBOL_BENCH_TEST && DISPLAY_ID != 1 && DISPLAY_ID != 2 && DISPLAY_ID != 3
#error "Symbol bench test is for D1, D2 or D3 only"
#endif

enum TrafficSymbol {
  SYMBOL_GREEN_UP_ARROW = 0,
  SYMBOL_YELLOW = 1,
  SYMBOL_RED_X = 2,
};

void drawPhysicalPixel(int x, int y, uint16_t color) {
  if (x < 0 || x >= PANEL_W || y < 0 || y >= PANEL_H) return;

  const int group = x / 16;
  const int dmaX =
    group * 32 + (x % 16)
    + ((((y / 8) & 1) ^ (group & 1)) * 16);
  const int dmaY =
    (y % 8) + ((y / 16) * 8);

  matrix->drawPixel(dmaX, dmaY, color);
}

void drawGreenArrow() {
  const uint16_t color = displayColor(0, 210, 0);

  for (int y = 2; y <= 15; ++y) {
    const int halfWidth = y - 2;
    for (int x = 31 - halfWidth; x <= 32 + halfWidth; ++x) {
      drawPhysicalPixel(x, y, color);
    }
  }

  for (int y = 16; y <= 29; ++y) {
    for (int x = 28; x <= 35; ++x) {
      drawPhysicalPixel(x, y, color);
    }
  }
}

void drawYellowSymbol() {
  const uint16_t color = displayColor(255, 255, 0);
  constexpr int top = 2;
  constexpr int bottom = 29;
  constexpr int maxHalfWidth = 15;

  for (int y = top; y <= bottom; ++y) {
    const int halfWidth =
      ((y - top) * maxHalfWidth) / (bottom - top);
    for (int x = 31 - halfWidth; x <= 32 + halfWidth; ++x) {
      drawPhysicalPixel(x, y, color);
    }
  }
}

void drawRedX() {
  const uint16_t color = displayColor(255, 0, 0);
  constexpr int left = 18;
  constexpr int top = 2;
  constexpr int size = 28;
  constexpr int halfThickness = 5;

  for (int y = 0; y < size; ++y) {
    for (int x = 0; x < size; ++x) {
      const int diagonal1 = x - y;
      const int diagonal2 = x + y - (size - 1);

      if ((diagonal1 >= -halfThickness && diagonal1 <= halfThickness) ||
          (diagonal2 >= -halfThickness && diagonal2 <= halfThickness)) {
        drawPhysicalPixel(left + x, top + y, color);
      }
    }
  }
}

int currentBenchSymbol() {
  return int((millis() / 3000UL) % 3);
}

int currentProductionSymbol(const String &fault) {
  if (stateColor == "red" || stateText == "STOP") return SYMBOL_RED_X;
  if (stateColor == "yellow" || stateText == "CAUTION") return SYMBOL_YELLOW;
  if (fault.length()) return SYMBOL_YELLOW;
  if (stateColor == "green" || stateText == "GO") return SYMBOL_GREEN_UP_ARROW;
  return SYMBOL_YELLOW;
}

void drawTrafficSymbol(int symbol) {
  matrix->fillScreen(0);

  if (symbol == SYMBOL_GREEN_UP_ARROW) {
    drawGreenArrow();
  } else if (symbol == SYMBOL_YELLOW) {
    drawYellowSymbol();
  } else {
    drawRedX();
  }
}

void drawScreen() {
#if DISPLAY_SYMBOL_MODE
  String fault = effectiveFault();
  logDrawAction(fault);

  int symbol;
#if SYMBOL_BENCH_TEST
  symbol = currentBenchSymbol();
#else
  symbol = currentProductionSymbol(fault);
#endif
  static String previousDrawKey = "";
  String drawKey = String(symbol) + "|" + fault;
  if (drawKey != previousDrawKey) {
    drawTrafficSymbol(symbol);
    previousDrawKey = drawKey;
    logEvent("DISPLAY", "symbol=%s scan=%d base=%d",
             symbol == SYMBOL_GREEN_UP_ARROW ? "UP_ARROW" :
             symbol == SYMBOL_YELLOW ? "YELLOW_TRIANGLE" : "RED_X",
             HUB75_SCAN_PROBE, HUB75_SCAN_PIXEL_BASE);
  }
#else

  if (stateColor == "red" || stateText == "STOP") {
    matrix->fillScreen(
      matrix->color565(255, 0, 0)
    );
    return;
  }

  if (stateColor == "yellow" || stateText == "CAUTION") {
    matrix->fillScreen(
      matrix->color565(255, 210, 0)
    );
    return;
  }

  // GREEN / default
  matrix->fillScreen(
    matrix->color565(0, 210, 0)
  );
#endif
}

void callback(char *topic, byte *payload, unsigned int length) {
  logEvent("MQTT", "RX topic=%s bytes=%u", topic, length);

  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, payload, length);
  if (error) {
    logEvent("MQTT", "JSON parse_error=%s", error.c_str());
    return;
  }

  String previousText = stateText;
  String previousColor = stateColor;
  String previousFault = sensorFaultText;

  stateText = String((const char *)(doc["text"] | ""));
  stateColor = String((const char *)(doc["color"] | ""));
  sensorFaultText = String((const char *)(doc["fault_text"] | ""));
  lastCommandMs = millis();

  logEvent(
    "MQTT",
    "parsed state=%s text=%s color=%s fault_text=%s",
    (const char *)(doc["state"] | ""),
    stateText.c_str(),
    stateColor.c_str(),
    sensorFaultText.c_str()
  );

  if (stateText != previousText || stateColor != previousColor || sensorFaultText != previousFault) {
    logEvent("STATE", "changed text=%s color=%s fault=%s", stateText.c_str(), stateColor.c_str(), sensorFaultText.c_str());
  }

  drawScreen();
}

void connectMqtt() {
  if (mqtt.connected() || millis() - lastMqttAttempt < 2000) return;
  lastMqttAttempt = millis();

  char clientId[32];
  snprintf(clientId, sizeof(clientId), "display-%d", DISPLAY_ID);
  logEvent("MQTT", "connecting client=%s broker=%s:%u", clientId, ipToString(MQTT_IP).c_str(), MQTT_PORT);

  if (mqtt.connect(clientId, statusTopic, 1, true, "offline")) {
    logEvent("MQTT", "connected");
    bool published = mqtt.publish(statusTopic, "online", true);
    logEvent("MQTT", "status publish topic=%s result=%s", statusTopic, published ? "OK" : "FAIL");
    bool subscribed = mqtt.subscribe(commandTopic, 1);
    logEvent("MQTT", "subscribed topic=%s result=%s", commandTopic, subscribed ? "OK" : "FAIL");
  } else {
    logEvent("MQTT", "connect_failed state=%d", mqtt.state());
  }

  drawScreen();
}

void logNetworkStatus(const char *category) {
  logEvent(category, "hardware=%s", hardwareStatusText(Ethernet.hardwareStatus()));
  logEvent(category, "link=%s", linkStatusText(Ethernet.linkStatus()));
  logEvent(category, "IP=%s", ipToString(Ethernet.localIP()).c_str());
  logEvent(category, "subnet=%s", ipToString(Ethernet.subnetMask()).c_str());
  logEvent(category, "gateway=%s", ipToString(Ethernet.gatewayIP()).c_str());
}

void logHeartbeat() {
  if (millis() - lastHeartbeatMs < 5000) return;
  lastHeartbeatMs = millis();
  logEvent(
    "HEART",
    "ETH=%s LINK=%s IP=%s MQTT=%s STATE=%s/%s heap=%u",
    hardwareStatusText(Ethernet.hardwareStatus()),
    linkStatusText(Ethernet.linkStatus()),
    ipToString(Ethernet.localIP()).c_str(),
    mqtt.connected() ? "ON" : "OFF",
    stateText.c_str(),
    stateColor.c_str(),
    ESP.getFreeHeap()
  );
}

void checkNetworkTransitions() {
  EthernetLinkStatus link = Ethernet.linkStatus();
  if (link != lastLinkStatus) {
    logEvent("ETH", "link_change %s -> %s", linkStatusText(lastLinkStatus), linkStatusText(link));
    lastLinkStatus = link;
    drawScreen();
  }

  bool connected = mqtt.connected();
  if (connected != lastMqttConnected) {
    logEvent("MQTT", "connection_change %s", connected ? "CONNECTED" : "DISCONNECTED");
    if (!connected) logEvent("MQTT", "disconnect_state=%d", mqtt.state());
    lastMqttConnected = connected;
    drawScreen();
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);

  printBanner();
  logEvent("BOOT", "setup START");
  logEvent("BOOT", "reset=%s", resetReasonText(esp_reset_reason()));
  logEvent("BOOT", "free_heap=%u flash=%u psram=%u", ESP.getFreeHeap(), ESP.getFlashChipSize(), ESP.getPsramSize());

  snprintf(commandTopic, sizeof(commandTopic), "factory/trafficlight/junction/1/display");
  snprintf(statusTopic, sizeof(statusTopic), "factory/trafficlight/junction/1/display/%d/status", DISPLAY_ID);

  logEvent("CONFIG", "DISPLAY_ID=%d", DISPLAY_ID);
  logEvent("CONFIG", "IP=%s", ipToString(DEVICE_IP).c_str());
  logEvent("CONFIG", "MQTT=%s:%u", ipToString(MQTT_IP).c_str(), MQTT_PORT);
  logEvent("CONFIG", "command_topic=%s", commandTopic);
  logEvent("CONFIG", "status_topic=%s", statusTopic);

  HUB75_I2S_CFG::i2s_pins hub75Pins = {
    42, 41, 40,
    39, 38, 37,
    48, 36, 45, HUB75_D_PIN, -1,
    47, 14, 2
  };

  logEvent("HUB75", "pins A=48 B=36 C=45 D=%d E=-1 LAT=47 OE=14 CLK=2", HUB75_D_PIN);

  HUB75_I2S_CFG mxconfig(DMA_PANEL_W, DMA_PANEL_H, PANEL_CHAIN, hub75Pins);
  logEvent("HUB75", "dma_config width=%d height=%d scan_probe=%d", DMA_PANEL_W, DMA_PANEL_H, HUB75_SCAN_PROBE);
  logEvent("HUB75", "init START");
  matrix = new MatrixPanel_I2S_DMA(mxconfig);
  if (!matrix->begin()) {
    logEvent("HUB75", "DMA allocation/init FAILED; restart required");
    while (true) delay(1000);
  }
  matrix->setBrightness8(MATRIX_BRIGHTNESS);

#if HUB75_SCAN_PROBE != 0
  scanMapper = new VirtualMatrixPanel(*matrix, 1, 1, PANEL_W, PANEL_H, CHAIN_NONE);
#if HUB75_SCAN_PROBE == 32
  scanMapper->setPhysicalPanelScanRate(FOUR_SCAN_32PX_HIGH, HUB75_SCAN_PIXEL_BASE);
#elif HUB75_SCAN_PROBE == 16
  scanMapper->setPhysicalPanelScanRate(FOUR_SCAN_16PX_HIGH, HUB75_SCAN_PIXEL_BASE);
#elif HUB75_SCAN_PROBE == 64
  scanMapper->setPhysicalPanelScanRate(FOUR_SCAN_64PX_HIGH, HUB75_SCAN_PIXEL_BASE);
#elif HUB75_SCAN_PROBE == 40
  scanMapper->setPhysicalPanelScanRate(FOUR_SCAN_40PX_HIGH, HUB75_SCAN_PIXEL_BASE);
#endif
  logEvent("HUB75", "virtual_scan probe=%d pixel_base=%d", HUB75_SCAN_PROBE, HUB75_SCAN_PIXEL_BASE);
#endif

  logEvent("HUB75", "init DONE brightness=%u", MATRIX_BRIGHTNESS);
  drawScreen();

  logEvent("SPI", "begin START");
  logEvent("SPI", "SCK=%u MISO=%u MOSI=%u CS=%u RST=%u", W5500_SCK, W5500_MISO, W5500_MOSI, W5500_CS, W5500_RST);

  logEvent("ETH", "W5500 reset START");
  pinMode(W5500_RST, OUTPUT);
  digitalWrite(W5500_RST, LOW);
  delay(10);
  digitalWrite(W5500_RST, HIGH);
  delay(200);
  logEvent("ETH", "W5500 reset DONE");

  SPI.begin(W5500_SCK, W5500_MISO, W5500_MOSI, W5500_CS);
  delay(100);
  logEvent("SPI", "begin DONE");

  logEvent("ETH", "Ethernet.init START");
  Ethernet.init(W5500_CS);
  logEvent("ETH", "Ethernet.init DONE");

  byte mac[] = {0x02, 0x54, 0x4C, 0x00, 0x00, (byte)DISPLAY_ID};
  logEvent("ETH", "MAC=%02X:%02X:%02X:%02X:%02X:%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  logEvent("ETH", "Ethernet.begin START");
  Ethernet.begin(mac, DEVICE_IP, DNS_IP, GATEWAY_IP, SUBNET_MASK);
  logEvent("ETH", "Ethernet.begin DONE");
  logNetworkStatus("ETH");
  lastLinkStatus = Ethernet.linkStatus();

  logEvent("MQTT", "broker=%s:%u", ipToString(MQTT_IP).c_str(), MQTT_PORT);
  mqtt.setServer(MQTT_IP, MQTT_PORT);
  mqtt.setCallback(callback);
  mqtt.setBufferSize(512);
  logEvent("MQTT", "buffer_size=512");
  logEvent("BOOT", "setup DONE");
}

void loop() {
#if DISPLAY_SYMBOL_MODE
  static_assert(DMA_PANEL_W == 128 && DMA_PANEL_H == 16,
                "Requires DMA 128x16");
  static_assert(PANEL_CHAIN == 1,
                "Requires one panel");
  matrix->setRotation(0);
#endif

#if SYMBOL_BENCH_TEST
  static unsigned long lastBenchDraw = 0;
  if (lastBenchDraw == 0 || millis() - lastBenchDraw >= 3000UL) {
    lastBenchDraw = millis();
    drawScreen();
  }
  delay(10);
  return;
#endif

  connectMqtt();
  mqtt.loop();
  checkNetworkTransitions();
  logHeartbeat();

  if (DISPLAY_LINE_SWEEP_TEST) {
    updateLineSweepTest();
    return;
  }

  static unsigned long lastDraw = 0;
  if (millis() - lastDraw > 500) {
    lastDraw = millis();
    drawScreen();
  }
}
