/*
  EthOTA: network upload server for the T3 displays (ESP32 + W5500).

  Vendored subset of JAndrassy/ArduinoOTA 1.1.0 (LGPL-2.1, see ../LICENSE),
  renamed so it cannot be confused with the ESP32 core's WiFi-only
  "ArduinoOTA" library. Upload protocol: HTTP POST /sketch on port 65280,
  basic auth "arduino:<password>".
*/
#ifndef _ETHOTA_H_
#define _ETHOTA_H_

#include "WiFiOTA.h"
#include "InternalStorageESP.h"

const uint16_t ETH_OTA_PORT = 65280;

template <class NetServer, class NetClient>
class EthOTAClass : public WiFiOTAClass {
 private:
  NetServer server;

 public:
  EthOTAClass() : server(ETH_OTA_PORT) {}

  void begin(IPAddress localIP, const char* name, const char* password, OTAStorage& storage) {
    WiFiOTAClass::begin(localIP, name, password, storage);
    server.begin();
  }

  void poll() {
    NetClient client = server.available();
    pollServer(client);
  }

  void handle() { poll(); }
};

#endif
