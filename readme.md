# IoT Monitoring Gempa & Pergerakan Tanah

Sistem monitoring realtime berbasis ESP32, MPU6050, soil moisture sensor, rain sensor, MQTT, dan dashboard web. ESP32 membaca sensor, menentukan level risiko, mengirim data ke broker MQTT, lalu dashboard menampilkan grafik dan alert high secara langsung.

## Fitur

- Monitoring akselerasi X, Y, Z, total getaran, kelembapan tanah, dan sensor hujan.
- Level risiko otomatis: `Normal`, `Waspada`, `Bahaya`, `Evakuasi`.
- Alarm lokal dengan LED dan buzzer.
- Publish MQTT retained untuk status penting, sehingga dashboard yang baru dibuka langsung menerima status terakhir.
- Payload telemetry JSON di `groundmovement/telemetry` plus topic per sensor untuk kompatibilitas.
- Reconnect WiFi dan MQTT otomatis tanpa menghentikan pembacaan sensor.
- Smoothing pembacaan sensor agar keputusan lebih stabil.
- Dashboard web dengan banner alert high, log event, status koneksi, usia data, dan grafik realtime.

## Struktur Folder

```text
arduino/
  sketch.ino        Kode ESP32
  libraries.txt     Library untuk Wokwi/Arduino
  diagram.json      Diagram simulasi Wokwi

monitoring-html/
  index.html        Dashboard realtime
  assets/css/       Style dashboard
  assets/js/        Logic MQTT, chart, alert, dan event log
  assets/fonts/     Font lokal Ubuntu untuk dashboard
  libs/             mqtt.js dan Chart.js lokal
```

## Hardware

- ESP32
- MPU6050
- Soil Moisture Sensor
- Rain Sensor
- LED hijau, kuning, merah
- Buzzer

## Library Arduino

Install library berikut di Arduino IDE atau gunakan `arduino/libraries.txt` jika memakai Wokwi:

- Adafruit MPU6050
- Adafruit Unified Sensor
- PubSubClient

## Konfigurasi MQTT

Edit bagian `Config` di [arduino/sketch.ino](arduino/sketch.ino):

```cpp
const char* WIFI_SSID = "Wokwi-GUEST";
const char* WIFI_PASSWORD = "";
const char* MQTT_HOST = "192.168.1.10";
const uint16_t MQTT_PORT = 1883;
```

Catatan penting:

- Untuk Wokwi, SSID `Wokwi-GUEST` bisa dipakai tanpa password.
- Untuk ESP32 fisik, isi SSID dan password WiFi yang benar.
- `MQTT_HOST` harus alamat broker dari sudut pandang ESP32. Jangan pakai `localhost` di ESP32, karena itu menunjuk ke ESP32 sendiri. Gunakan IP komputer/server broker, misalnya `192.168.1.10`.
- Dashboard memakai WebSocket MQTT, default `ws://localhost:9001`. Jika dashboard dibuka dari perangkat lain, gunakan `ws://IP_BROKER:9001`.

Contoh konfigurasi Mosquitto lokal:

```conf
listener 1883 0.0.0.0

listener 9001 0.0.0.0
protocol websockets

allow_anonymous true
```

Jalankan Mosquitto dengan konfigurasi tersebut, lalu samakan:

- Arduino: `MQTT_HOST = "IP_BROKER"` dan `MQTT_PORT = 1883`
- Dashboard: `ws://IP_BROKER:9001`

## Menjalankan Dashboard

Buka [monitoring-html/index.html](monitoring-html/index.html) di browser.

Default broker:

```text
ws://localhost:9001
```

Broker juga bisa diubah langsung dari input di header dashboard atau lewat query string:

```text
monitoring-html/index.html?broker=ws://192.168.1.10:9001
```

Saat `alert/level` bernilai `2` atau `3`, atau `alert/high` bernilai `1`, banner alert high langsung muncul di dashboard. Tombol `Sound On` bisa mengaktifkan nada alert browser setelah ada interaksi pengguna.

## Topic MQTT

| Topic | Isi |
| --- | --- |
| `groundmovement/telemetry` | JSON lengkap data sensor dan status |
| `earthquake/accel/x` | Akselerasi sumbu X |
| `earthquake/accel/y` | Akselerasi sumbu Y |
| `earthquake/accel/z` | Akselerasi sumbu Z |
| `earthquake/vibration` | Total getaran dari baseline MPU6050 |
| `landslide/moisture` | Nilai ADC kelembapan tanah |
| `landslide/rain` | Nilai ADC sensor hujan |
| `alert/status` | `Normal`, `Waspada`, `Bahaya`, atau `Evakuasi` |
| `alert/level` | `0`, `1`, `2`, atau `3` |
| `alert/high` | `1` untuk level high, `0` untuk normal/waspada |
| `alert/message` | Ringkasan penyebab alert |
| `system/status` | `online` atau `offline` |
| `system/ip` | IP ESP32 |
| `system/uptime` | Uptime ESP32 dalam detik |
| `system/rssi` | Kekuatan sinyal WiFi dalam dBm |

## Level Risiko

| Level | Status | Kondisi |
| --- | --- | --- |
| 0 | Normal | Sensor di bawah ambang waspada |
| 1 | Waspada | Getaran >= 2.5 atau soil/rain >= 1500 |
| 2 | Bahaya | Getaran >= 5.0 atau soil/rain >= 2200 |
| 3 | Evakuasi | Getaran >= 8.0 atau soil/rain >= 3000 |

Jika MPU6050 tidak terbaca, sistem menaikkan level minimal ke `Bahaya` agar perangkat segera diperiksa.

## Alur Sistem

```text
Sensor -> ESP32 -> MQTT Broker -> Dashboard Web -> Alert visual/audio
```

## Troubleshooting

- Dashboard tidak menerima data: pastikan broker WebSocket aktif di port `9001` dan topic sudah tersubscribe.
- ESP32 tidak connect MQTT: pastikan `MQTT_HOST` adalah IP broker yang bisa dijangkau ESP32, bukan `localhost`.
- Dashboard menampilkan data stale: ESP32 tidak publish lebih dari 10 detik, cek WiFi, broker, dan daya perangkat.
- Alert tidak muncul: cek topic `alert/level` bernilai `2` atau `3`, atau `alert/high` bernilai `1`.
- Buzzer terus aktif: lihat Serial Monitor untuk mengetahui sensor mana yang melewati ambang.
