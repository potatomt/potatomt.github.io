// SmartGuard 32 dashboard - settings you type in yourself.
//
// This file is PUBLIC (the repo is public). That is expected:
// the "web" MQTT user can only read sg/<DEVICE_ID>/# and publish to
// sg/<DEVICE_ID>/cmd, and the ESP32 checks the PIN itself.
// Never put the Wi-Fi password, the master password or the PIN here.

const CONFIG = {
  MQTT_HOST: "e01f28da.ala.eu-central-1.emqxsl.com",         // broker address only, no "wss://" and no port
  DEVICE_ID: "ali7f3k",         // same DEVICE_ID as in the ESP32's secrets.py
  WEB_PASSWORD: "^n07SdsWvxQ",   // password of the MQTT user "web"
};
