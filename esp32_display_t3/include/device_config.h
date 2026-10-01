#pragma once
#include <IPAddress.h>

// ---------------------------------------------------------------- identity
#ifndef DISPLAY_ID
#define DISPLAY_ID 1
#endif
static_assert(DISPLAY_ID >= 1 && DISPLAY_ID <= 7, "DISPLAY_ID must be 1..7");

#ifndef T3_JUNCTION_ID
#define T3_JUNCTION_ID "T3"
#endif

#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "t3-1.0.0"
#endif

// Must match "ota.password" in the junction's settings.json on the Pi.
#ifndef OTA_PASSWORD
#define OTA_PASSWORD "change-me"
#endif

// ---------------------------------------------------------------- network
// display Bn = 10.77.0.(DISPLAY_IP_BASE + n): T3 uses .31 .32 ... (other junctions T1, T2 ... take other blocks)
#ifndef DISPLAY_IP_BASE
#define DISPLAY_IP_BASE 30
#endif
static IPAddress DEVICE_IP(10, 77, 0, DISPLAY_IP_BASE + DISPLAY_ID);
static IPAddress DNS_IP(10, 77, 0, 1);
static IPAddress GATEWAY_IP(0, 0, 0, 0);
static IPAddress SUBNET_MASK(255, 255, 255, 0);
static IPAddress MQTT_IP(10, 77, 0, 1);
#define MQTT_PORT 1883
#define MQTT_BASE "factory/trafficlight/" T3_JUNCTION_ID

// W5500 pins (field-proven, ArtronShop ESP-HUB75 03K26 + Mini W5500)
#define W5500_CS   21
#define W5500_MOSI 13
#define W5500_SCK  12
#define W5500_MISO 11
#define W5500_RST  4

// ---------------------------------------------------------------- panel
#ifndef HUB75_D_PIN
#define HUB75_D_PIN 35
#endif
#define PANEL_W 64
#define PANEL_H 32
#define PANEL_CHAIN 1
// Field-confirmed: one 64x32 panel driven as a 128x16 DMA canvas with the
// custom pixel mapping in drawPhysicalPixel() (same as V1 symbol builds).
#define DMA_PANEL_W 128
#define DMA_PANEL_H 16
#define MATRIX_BRIGHTNESS 60

// ---------------------------------------------------------------- safety timing
// A command is valid for its ttl_ms (sent by the Pi, capped here). No fresh
// command -> LINK LOST (never green).
#define CMD_TTL_MAX_MS 5000UL
// Hardware watchdog: if loop() stops running for this long (hang) the display
// restarts itself, so it can never keep showing an old green. Not active while
// an OTA upload is in progress.
#define WDT_TIMEOUT_MS 8000UL
// After an OTA update the new firmware must receive a valid controller
// command within this window, otherwise it boots the previous firmware.
#define OTA_ROLLBACK_WINDOW_MS 120000UL
