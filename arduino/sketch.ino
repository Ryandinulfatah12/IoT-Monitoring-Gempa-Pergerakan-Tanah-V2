#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <math.h>

Adafruit_MPU6050 mpu;
WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);

constexpr uint8_t SOIL_PIN = 34;
constexpr uint8_t RAIN_PIN = 35;
constexpr uint8_t BUZZER_PIN = 25;
constexpr uint8_t LED_GREEN = 26;
constexpr uint8_t LED_YELLOW = 27;
constexpr uint8_t LED_RED = 14;

namespace Config {
  // Wokwi: use "Wokwi-GUEST" with empty password.
  // Real ESP32: change these values to your WiFi.
  const char* WIFI_SSID = "Wokwi-GUEST";
  const char* WIFI_PASSWORD = "";

  // Use the same broker used by monitoring-html/index.html.
  // For a local Mosquitto broker, this must be the PC/LAN IP, not "localhost".
  const char* MQTT_HOST = "192.168.1.10";
  const uint16_t MQTT_PORT = 1883;
  const char* MQTT_USER = "";
  const char* MQTT_PASSWORD = "";
  const char* MQTT_CLIENT_PREFIX = "esp32-ground-";

  constexpr uint32_t SENSOR_INTERVAL_MS = 250;
  constexpr uint32_t PUBLISH_INTERVAL_MS = 1000;
  constexpr uint32_t SERIAL_INTERVAL_MS = 2000;
  constexpr uint32_t WIFI_RETRY_MS = 5000;
  constexpr uint32_t MQTT_RETRY_MS = 5000;
  constexpr uint32_t MPU_RETRY_MS = 5000;
  constexpr float FILTER_ALPHA = 0.30f;
}

namespace Threshold {
  constexpr float VIBRATION_WASPADA = 2.5f;
  constexpr float VIBRATION_BAHAYA = 5.0f;
  constexpr float VIBRATION_EVAKUASI = 8.0f;
  constexpr int SOIL_WASPADA = 1500;
  constexpr int SOIL_BAHAYA = 2200;
  constexpr int SOIL_EVAKUASI = 3000;
  constexpr int RAIN_WASPADA = 1500;
  constexpr int RAIN_BAHAYA = 2200;
  constexpr int RAIN_EVAKUASI = 3000;
}

namespace Topic {
  const char* TELEMETRY = "groundmovement/telemetry";
  const char* ACCEL_X = "earthquake/accel/x";
  const char* ACCEL_Y = "earthquake/accel/y";
  const char* ACCEL_Z = "earthquake/accel/z";
  const char* VIBRATION = "earthquake/vibration";
  const char* SOIL = "landslide/moisture";
  const char* RAIN = "landslide/rain";
  const char* ALERT_STATUS = "alert/status";
  const char* ALERT_LEVEL = "alert/level";
  const char* ALERT_HIGH = "alert/high";
  const char* ALERT_MESSAGE = "alert/message";
  const char* SYSTEM_STATUS = "system/status";
  const char* SYSTEM_IP = "system/ip";
  const char* SYSTEM_UPTIME = "system/uptime";
  const char* SYSTEM_RSSI = "system/rssi";
}

struct SensorFrame {
  float x = 0.0f;
  float y = 0.0f;
  float z = 9.81f;
  float vibration = 0.0f;
  int soil = 0;
  int rain = 0;
  uint8_t level = 0;
  const char* status = "Normal";
  bool highAlert = false;
  bool mpuOk = false;
};

SensorFrame frame;

float baselineX = 0.0f;
float baselineY = 0.0f;
float baselineZ = 9.81f;
float filteredSoil = 0.0f;
float filteredRain = 0.0f;
bool filterReady = false;
bool mpuReady = false;

char alertMessage[128] = "Kondisi stabil";

uint32_t lastSensorRead = 0;
uint32_t lastPublish = 0;
uint32_t lastSerial = 0;
uint32_t lastWifiAttempt = 0;
uint32_t lastMqttAttempt = 0;
uint32_t lastMpuRetry = 0;

float ema(float previous, float current) {
  return previous + (Config::FILTER_ALPHA * (current - previous));
}

const char* statusText(uint8_t level) {
  if (level == 1) return "Waspada";
  if (level == 2) return "Bahaya";
  if (level >= 3) return "Evakuasi";
  return "Normal";
}

void setupPins() {
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LED_GREEN, OUTPUT);
  pinMode(LED_YELLOW, OUTPUT);
  pinMode(LED_RED, OUTPUT);

  digitalWrite(LED_GREEN, LOW);
  digitalWrite(LED_YELLOW, LOW);
  digitalWrite(LED_RED, LOW);
  noTone(BUZZER_PIN);

  analogReadResolution(12);
  analogSetPinAttenuation(SOIL_PIN, ADC_11db);
  analogSetPinAttenuation(RAIN_PIN, ADC_11db);
}

bool initMpu() {
  if (!mpu.begin()) {
    return false;
  }

  mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
  mpu.setGyroRange(MPU6050_RANGE_500_DEG);
  mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
  return true;
}

void calibrateMpu() {
  if (!mpuReady) return;

  constexpr uint8_t samples = 40;
  float sumX = 0.0f;
  float sumY = 0.0f;
  float sumZ = 0.0f;

  for (uint8_t i = 0; i < samples; i++) {
    sensors_event_t accel;
    sensors_event_t gyro;
    sensors_event_t temp;
    mpu.getEvent(&accel, &gyro, &temp);
    sumX += accel.acceleration.x;
    sumY += accel.acceleration.y;
    sumZ += accel.acceleration.z;
    delay(10);
  }

  baselineX = sumX / samples;
  baselineY = sumY / samples;
  baselineZ = sumZ / samples;

  Serial.print("MPU6050 baseline X/Y/Z: ");
  Serial.print(baselineX, 2);
  Serial.print(" / ");
  Serial.print(baselineY, 2);
  Serial.print(" / ");
  Serial.println(baselineZ, 2);
}

void maintainWiFi(bool force = false) {
  if (WiFi.status() == WL_CONNECTED) return;

  const uint32_t now = millis();
  if (!force && lastWifiAttempt != 0 && now - lastWifiAttempt < Config::WIFI_RETRY_MS) {
    return;
  }

  lastWifiAttempt = now;
  WiFi.disconnect(false);
  WiFi.begin(Config::WIFI_SSID, Config::WIFI_PASSWORD);

  Serial.print("WiFi connecting to ");
  Serial.println(Config::WIFI_SSID);
}

void publishText(const char* topic, const char* value, bool retained = true) {
  mqtt.publish(topic, value, retained);
}

void publishInt(const char* topic, long value, bool retained = true) {
  char payload[24];
  snprintf(payload, sizeof(payload), "%ld", value);
  mqtt.publish(topic, payload, retained);
}

void publishFloat(const char* topic, float value, uint8_t decimals = 2, bool retained = true) {
  char payload[24];
  dtostrf(value, 0, decimals, payload);
  mqtt.publish(topic, payload, retained);
}

void formatIpAddress(char* buffer, size_t bufferSize, IPAddress ip) {
  snprintf(
    buffer,
    bufferSize,
    "%u.%u.%u.%u",
    static_cast<unsigned int>(ip[0]),
    static_cast<unsigned int>(ip[1]),
    static_cast<unsigned int>(ip[2]),
    static_cast<unsigned int>(ip[3])
  );
}

void publishState(bool retained = true) {
  if (!mqtt.connected()) return;

  publishFloat(Topic::ACCEL_X, frame.x, 2, retained);
  publishFloat(Topic::ACCEL_Y, frame.y, 2, retained);
  publishFloat(Topic::ACCEL_Z, frame.z, 2, retained);
  publishFloat(Topic::VIBRATION, frame.vibration, 2, retained);
  publishInt(Topic::SOIL, frame.soil, retained);
  publishInt(Topic::RAIN, frame.rain, retained);
  publishText(Topic::ALERT_STATUS, frame.status, true);
  publishInt(Topic::ALERT_LEVEL, frame.level, true);
  publishText(Topic::ALERT_HIGH, frame.highAlert ? "1" : "0", true);
  publishText(Topic::ALERT_MESSAGE, alertMessage, true);
  publishInt(Topic::SYSTEM_UPTIME, millis() / 1000UL, true);
  publishInt(Topic::SYSTEM_RSSI, WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0, true);

  char telemetry[320];
  snprintf(
    telemetry,
    sizeof(telemetry),
    "{\"x\":%.2f,\"y\":%.2f,\"z\":%.2f,\"vibration\":%.2f,\"soil\":%d,\"rain\":%d,\"level\":%u,\"status\":\"%s\",\"high\":%s,\"message\":\"%s\",\"mpuOk\":%s,\"uptime\":%lu,\"rssi\":%ld}",
    frame.x,
    frame.y,
    frame.z,
    frame.vibration,
    frame.soil,
    frame.rain,
    frame.level,
    frame.status,
    frame.highAlert ? "true" : "false",
    alertMessage,
    frame.mpuOk ? "true" : "false",
    millis() / 1000UL,
    WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0L
  );

  mqtt.publish(Topic::TELEMETRY, telemetry, retained);
}

void maintainMqtt(bool force = false) {
  if (mqtt.connected()) return;
  if (WiFi.status() != WL_CONNECTED) return;

  const uint32_t now = millis();
  if (!force && lastMqttAttempt != 0 && now - lastMqttAttempt < Config::MQTT_RETRY_MS) {
    return;
  }

  lastMqttAttempt = now;

  char clientId[48];
  const uint32_t chipId = static_cast<uint32_t>(ESP.getEfuseMac() & 0xFFFFFF);
  snprintf(clientId, sizeof(clientId), "%s%06lX", Config::MQTT_CLIENT_PREFIX, static_cast<unsigned long>(chipId));

  bool connected = false;
  if (strlen(Config::MQTT_USER) > 0) {
    connected = mqtt.connect(
      clientId,
      Config::MQTT_USER,
      Config::MQTT_PASSWORD,
      Topic::SYSTEM_STATUS,
      1,
      true,
      "offline"
    );
  } else {
    connected = mqtt.connect(
      clientId,
      Topic::SYSTEM_STATUS,
      1,
      true,
      "offline"
    );
  }

  if (connected) {
    Serial.println("MQTT connected");
    char ipPayload[16];
    formatIpAddress(ipPayload, sizeof(ipPayload), WiFi.localIP());
    publishText(Topic::SYSTEM_STATUS, "online", true);
    publishText(Topic::SYSTEM_IP, ipPayload, true);
    publishState(true);
  } else {
    Serial.print("MQTT connect failed, state=");
    Serial.println(mqtt.state());
  }
}

uint8_t evaluateLevel(const SensorFrame& sample) {
  uint8_t level = 0;

  if (
    sample.vibration >= Threshold::VIBRATION_EVAKUASI ||
    sample.soil >= Threshold::SOIL_EVAKUASI ||
    sample.rain >= Threshold::RAIN_EVAKUASI
  ) {
    level = 3;
  } else if (
    sample.vibration >= Threshold::VIBRATION_BAHAYA ||
    sample.soil >= Threshold::SOIL_BAHAYA ||
    sample.rain >= Threshold::RAIN_BAHAYA
  ) {
    level = 2;
  } else if (
    sample.vibration >= Threshold::VIBRATION_WASPADA ||
    sample.soil >= Threshold::SOIL_WASPADA ||
    sample.rain >= Threshold::RAIN_WASPADA
  ) {
    level = 1;
  }

  if (!sample.mpuOk && level < 2) {
    level = 2;
  }

  return level;
}

void composeAlertMessage() {
  if (!frame.mpuOk) {
    snprintf(alertMessage, sizeof(alertMessage), "MPU6050 tidak terbaca. Periksa kabel SDA/SCL dan daya sensor.");
    return;
  }

  if (frame.level == 0) {
    snprintf(alertMessage, sizeof(alertMessage), "Kondisi stabil. Getaran %.2f, tanah %d ADC, hujan %d ADC.", frame.vibration, frame.soil, frame.rain);
  } else if (frame.level == 1) {
    snprintf(alertMessage, sizeof(alertMessage), "Waspada. Ada kenaikan sensor: getaran %.2f, tanah %d ADC, hujan %d ADC.", frame.vibration, frame.soil, frame.rain);
  } else if (frame.level == 2) {
    snprintf(alertMessage, sizeof(alertMessage), "Bahaya. Periksa area segera: getaran %.2f, tanah %d ADC, hujan %d ADC.", frame.vibration, frame.soil, frame.rain);
  } else {
    snprintf(alertMessage, sizeof(alertMessage), "Evakuasi. Level kritis: getaran %.2f, tanah %d ADC, hujan %d ADC.", frame.vibration, frame.soil, frame.rain);
  }
}

void retryMpuIfNeeded() {
  if (mpuReady) return;

  const uint32_t now = millis();
  if (lastMpuRetry != 0 && now - lastMpuRetry < Config::MPU_RETRY_MS) {
    return;
  }

  lastMpuRetry = now;
  Serial.println("Retry MPU6050...");
  mpuReady = initMpu();

  if (mpuReady) {
    Serial.println("MPU6050 recovered");
    calibrateMpu();
    filterReady = false;
  }
}

void readSensors() {
  retryMpuIfNeeded();

  sensors_event_t accel;
  sensors_event_t gyro;
  sensors_event_t temp;

  bool gotMpu = false;
  if (mpuReady) {
    gotMpu = mpu.getEvent(&accel, &gyro, &temp);
    if (!gotMpu) {
      Serial.println("MPU6050 read failed");
      mpuReady = false;
    }
  }

  const float rawX = gotMpu ? accel.acceleration.x : baselineX;
  const float rawY = gotMpu ? accel.acceleration.y : baselineY;
  const float rawZ = gotMpu ? accel.acceleration.z : baselineZ;
  const int rawSoil = analogRead(SOIL_PIN);
  const int rawRain = analogRead(RAIN_PIN);

  if (!filterReady) {
    frame.x = rawX;
    frame.y = rawY;
    frame.z = rawZ;
    filteredSoil = rawSoil;
    filteredRain = rawRain;
    filterReady = true;
  } else {
    frame.x = ema(frame.x, rawX);
    frame.y = ema(frame.y, rawY);
    frame.z = ema(frame.z, rawZ);
    filteredSoil = ema(filteredSoil, rawSoil);
    filteredRain = ema(filteredRain, rawRain);
  }

  frame.vibration = fabs(frame.x - baselineX) + fabs(frame.y - baselineY) + fabs(frame.z - baselineZ);
  frame.soil = static_cast<int>(filteredSoil + 0.5f);
  frame.rain = static_cast<int>(filteredRain + 0.5f);
  frame.mpuOk = gotMpu;
  frame.level = evaluateLevel(frame);
  frame.status = statusText(frame.level);
  frame.highAlert = frame.level >= 2;

  composeAlertMessage();
}

void updateOutputs() {
  digitalWrite(LED_GREEN, frame.level == 0 ? HIGH : LOW);
  digitalWrite(LED_YELLOW, frame.level == 1 ? HIGH : LOW);
  digitalWrite(LED_RED, frame.level >= 2 ? HIGH : LOW);

  if (frame.level < 2) {
    noTone(BUZZER_PIN);
    return;
  }

  const uint32_t period = frame.level >= 3 ? 300UL : 900UL;
  const uint32_t onTime = frame.level >= 3 ? 170UL : 280UL;
  const uint16_t frequency = frame.level >= 3 ? 1800 : 1200;

  if ((millis() % period) < onTime) {
    tone(BUZZER_PIN, frequency);
  } else {
    noTone(BUZZER_PIN);
  }
}

void printSerialReport() {
  Serial.println();
  Serial.println("========================================");
  Serial.println(" EARTHQUAKE & LANDSLIDE MONITOR");
  Serial.println("========================================");
  Serial.print("WiFi: ");
  if (WiFi.status() == WL_CONNECTED) {
    char ipPayload[16];
    formatIpAddress(ipPayload, sizeof(ipPayload), WiFi.localIP());
    Serial.print(ipPayload);
  } else {
    Serial.print("disconnected");
  }
  Serial.print(" | MQTT: ");
  Serial.println(mqtt.connected() ? "connected" : "disconnected");

  Serial.print("X/Y/Z: ");
  Serial.print(frame.x, 2);
  Serial.print(" / ");
  Serial.print(frame.y, 2);
  Serial.print(" / ");
  Serial.print(frame.z, 2);
  Serial.println(" m/s^2");

  Serial.print("Vibration: ");
  Serial.print(frame.vibration, 2);
  Serial.print(" | Soil: ");
  Serial.print(frame.soil);
  Serial.print(" ADC | Rain: ");
  Serial.print(frame.rain);
  Serial.println(" ADC");

  Serial.print("Status: ");
  Serial.print(frame.status);
  Serial.print(" | Level: ");
  Serial.println(frame.level);
  Serial.print("Message: ");
  Serial.println(alertMessage);
  Serial.println("========================================");
}

void setup() {
  Serial.begin(115200);
  delay(100);

  setupPins();
  Wire.begin(21, 22);

  mpuReady = initMpu();
  if (mpuReady) {
    calibrateMpu();
  } else {
    Serial.println("MPU6050 tidak terdeteksi, sistem akan retry otomatis.");
  }

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);

  mqtt.setServer(Config::MQTT_HOST, Config::MQTT_PORT);
  mqtt.setKeepAlive(30);
  mqtt.setSocketTimeout(3);
  mqtt.setBufferSize(512);

  maintainWiFi(true);

  Serial.println("Sistem IoT Gempa & Pergerakan Tanah aktif");
}

void loop() {
  const uint32_t now = millis();

  maintainWiFi();
  maintainMqtt();
  if (mqtt.connected()) {
    mqtt.loop();
  }

  if (now - lastSensorRead >= Config::SENSOR_INTERVAL_MS) {
    lastSensorRead = now;
    readSensors();
  }

  updateOutputs();

  if (now - lastPublish >= Config::PUBLISH_INTERVAL_MS) {
    lastPublish = now;
    publishState(true);
  }

  if (now - lastSerial >= Config::SERIAL_INTERVAL_MS) {
    lastSerial = now;
    printSerialReport();
  }
}
