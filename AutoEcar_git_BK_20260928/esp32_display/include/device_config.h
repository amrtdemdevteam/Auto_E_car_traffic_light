#pragma once
#include <IPAddress.h>

#ifndef DISPLAY_ID
#define DISPLAY_ID 1
#endif
static_assert(DISPLAY_ID >= 1 && DISPLAY_ID <= 7, "DISPLAY_ID must be 1..7");

#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "1.0.4-field-v1"
#endif

static IPAddress DEVICE_IP(10,77,0,10 + DISPLAY_ID);
static IPAddress DNS_IP(10,77,0,1);
static IPAddress GATEWAY_IP(0,0,0,0);
static IPAddress SUBNET_MASK(255,255,255,0);
static IPAddress MQTT_IP(10,77,0,1);

// W5500 pins from the approved project design.
#define W5500_CS   21
#define W5500_MOSI 13
#define W5500_SCK  12
#define W5500_MISO 11
#define W5500_RST 4

#ifndef HUB75_D_PIN
#define HUB75_D_PIN 35
#endif

#ifndef HUB75_SCAN_PROBE
#define HUB75_SCAN_PROBE 0
#endif

#ifndef HUB75_SCAN_PIXEL_BASE
#define HUB75_SCAN_PIXEL_BASE 64
#endif


#define PANEL_W 64
#define PANEL_H 32
#define PANEL_CHAIN 1
#define MQTT_PORT 1883
#define MQTT_COMMAND_TIMEOUT_MS 5000UL
#define MATRIX_BRIGHTNESS 60

// HUB75 GPIO map is explicitly configured in src/main.cpp for the exact
// ArtronShop ESP-HUB75 (product 03K26) board. Always bench-test one panel
// before flashing all seven units.
