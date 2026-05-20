(() => {
  const DEFAULT_BROKER_URL = "ws://localhost:9001";
  const TOPICS = [
    "groundmovement/telemetry",
    "earthquake/accel/x",
    "earthquake/accel/y",
    "earthquake/accel/z",
    "earthquake/vibration",
    "landslide/moisture",
    "landslide/rain",
    "alert/status",
    "alert/level",
    "alert/high",
    "alert/message",
    "system/status",
    "system/ip",
    "system/uptime",
    "system/rssi",
  ];

  const LEVEL_LABELS = ["Normal", "Waspada", "Bahaya", "Evakuasi"];
  const LEVEL_CLASSES = ["normal", "waspada", "bahaya", "evakuasi"];
  const MAX_CHART_SAMPLES = 60;
  const STALE_AFTER_MS = 10000;

  const state = {
    x: 0,
    y: 0,
    z: 9.81,
    vibration: 0,
    soil: 0,
    rain: 0,
    level: 0,
    status: "Normal",
    high: false,
    message: "Menunggu data sensor.",
    mpuOk: null,
    uptime: 0,
    rssi: 0,
    deviceStatus: "-",
    deviceIp: "-",
    brokerUrl: "",
    lastMessageAt: 0,
    connectionMode: "connecting",
  };

  const events = [];
  let client = null;
  let accelChart = null;
  let soundEnabled = false;
  let audioContext = null;
  let currentAlertKey = "";
  let alertAcknowledged = false;

  const els = {};

  function collectElements() {
    [
      "connectionForm",
      "brokerInput",
      "connectButton",
      "soundButton",
      "mqttStatus",
      "brokerText",
      "mqttStateText",
      "lastUpdate",
      "dataAgeText",
      "highValue",
      "levelValue",
      "statusValue",
      "levelCard",
      "statusCard",
      "vibrationValue",
      "xValue",
      "yValue",
      "zValue",
      "soilValue",
      "rainValue",
      "conclusionText",
      "deviceMeta",
      "eventLog",
      "criticalAlert",
      "criticalTitle",
      "criticalStatus",
      "criticalTime",
      "criticalMessage",
      "ackAlert",
    ].forEach((id) => {
      els[id] = document.getElementById(id);
    });
  }

  function readStoredBroker() {
    const params = new URLSearchParams(window.location.search);
    const brokerFromUrl = params.get("broker");
    if (brokerFromUrl) return brokerFromUrl;

    try {
      return localStorage.getItem("mqttBrokerUrl") || DEFAULT_BROKER_URL;
    } catch (error) {
      return DEFAULT_BROKER_URL;
    }
  }

  function storeBroker(url) {
    try {
      localStorage.setItem("mqttBrokerUrl", url);
    } catch (error) {
      // Storage can be disabled in private browser modes.
    }
  }

  function parseNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function parseBoolean(value) {
    if (typeof value === "boolean") return value;
    const normalized = String(value).trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "high";
  }

  function clampLevel(value) {
    const level = Number.parseInt(value, 10);
    if (!Number.isFinite(level)) return state.level;
    return Math.max(0, Math.min(3, level));
  }

  function levelClass() {
    return LEVEL_CLASSES[state.level] || "normal";
  }

  function levelLabel() {
    return LEVEL_LABELS[state.level] || state.status || "Normal";
  }

  function isHighAlert() {
    return state.level >= 2 || state.high;
  }

  function isStale() {
    return state.lastMessageAt > 0 && Date.now() - state.lastMessageAt > STALE_AFTER_MS;
  }

  function formatNumber(value, decimals = 2) {
    return parseNumber(value, 0).toFixed(decimals);
  }

  function formatAcceleration(value) {
    return formatNumber(value) + " m/s<sup>2</sup>";
  }

  function formatClock(time) {
    return new Date(time).toLocaleTimeString("id-ID", { hour12: false });
  }

  function formatAge() {
    if (!state.lastMessageAt) return "Menunggu data";
    const ageSeconds = Math.max(0, Math.round((Date.now() - state.lastMessageAt) / 1000));
    return ageSeconds + " detik";
  }

  function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Number(totalSeconds) || 0);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    if (hours > 0) return hours + "j " + minutes + "m";
    if (minutes > 0) return minutes + "m " + rest + "d";
    return rest + "d";
  }

  function setConnection(mode, label) {
    state.connectionMode = mode;
    els.mqttStateText.textContent = label;
    els.mqttStatus.textContent = "MQTT: " + label;
    els.mqttStatus.className = "pill";

    if (mode === "connected") {
      els.mqttStatus.classList.add("connected");
    } else if (mode === "error" || mode === "offline") {
      els.mqttStatus.classList.add("error");
    } else {
      els.mqttStatus.classList.add("warning");
    }
  }

  function connectMqtt(url) {
    if (typeof mqtt === "undefined") {
      setConnection("error", "Library MQTT tidak ditemukan");
      addEvent("system", "mqtt.min.js gagal dimuat.");
      return;
    }

    const brokerUrl = url || DEFAULT_BROKER_URL;
    state.brokerUrl = brokerUrl;
    els.brokerInput.value = brokerUrl;
    els.brokerText.textContent = "Broker: " + brokerUrl;
    storeBroker(brokerUrl);

    if (client) {
      client.end(true);
      client = null;
    }

    setConnection("connecting", "Menghubungkan");
    addEvent("system", "Menghubungkan ke " + brokerUrl);

    const nextClient = mqtt.connect(brokerUrl, {
      clientId: "dashboard-ground-" + Math.random().toString(16).slice(2),
      clean: true,
      connectTimeout: 8000,
      reconnectPeriod: 3000,
      keepalive: 30,
    });

    client = nextClient;
    bindMqttEvents(nextClient);
  }

  function bindMqttEvents(nextClient) {
    nextClient.on("connect", () => {
      if (client !== nextClient) return;
      setConnection("connected", "Terhubung");
      addEvent("system", "MQTT terhubung.");
      nextClient.subscribe(TOPICS, { qos: 0 }, (error) => {
        if (client !== nextClient) return;
        if (error) {
          addEvent("system", "Subscribe topic gagal: " + error.message);
        } else {
          addEvent("system", "Topic monitoring aktif.");
        }
      });
    });

    nextClient.on("reconnect", () => {
      if (client !== nextClient) return;
      setConnection("reconnecting", "Reconnect");
    });

    nextClient.on("offline", () => {
      if (client !== nextClient) return;
      setConnection("offline", "Offline");
    });

    nextClient.on("close", () => {
      if (client !== nextClient) return;
      if (state.connectionMode !== "reconnecting") {
        setConnection("offline", "Terputus");
      }
    });

    nextClient.on("error", (error) => {
      if (client !== nextClient) return;
      setConnection("error", "Error");
      addEvent("system", "MQTT error: " + error.message);
    });

    nextClient.on("message", (topic, messageBuffer) => {
      if (client !== nextClient) return;
      handleMessage(topic, messageBuffer);
    });
  }

  function handleMessage(topic, messageBuffer) {
    const payload = messageBuffer.toString().trim();
    state.lastMessageAt = Date.now();

    if (topic === "groundmovement/telemetry") {
      applyTelemetry(payload);
    } else if (topic === "earthquake/accel/x") {
      state.x = parseNumber(payload, state.x);
    } else if (topic === "earthquake/accel/y") {
      state.y = parseNumber(payload, state.y);
    } else if (topic === "earthquake/accel/z") {
      state.z = parseNumber(payload, state.z);
    } else if (topic === "earthquake/vibration") {
      state.vibration = parseNumber(payload, state.vibration);
    } else if (topic === "landslide/moisture") {
      state.soil = Math.round(parseNumber(payload, state.soil));
    } else if (topic === "landslide/rain") {
      state.rain = Math.round(parseNumber(payload, state.rain));
    } else if (topic === "alert/status") {
      state.status = payload || state.status;
    } else if (topic === "alert/level") {
      state.level = clampLevel(payload);
      state.status = LEVEL_LABELS[state.level] || state.status;
    } else if (topic === "alert/high") {
      state.high = parseBoolean(payload);
    } else if (topic === "alert/message") {
      state.message = payload || state.message;
    } else if (topic === "system/status") {
      state.deviceStatus = payload || "-";
    } else if (topic === "system/ip") {
      state.deviceIp = payload || "-";
    } else if (topic === "system/uptime") {
      state.uptime = Math.max(0, Math.round(parseNumber(payload, state.uptime)));
    } else if (topic === "system/rssi") {
      state.rssi = Math.round(parseNumber(payload, state.rssi));
    }

    renderDashboard();
  }

  function applyTelemetry(payload) {
    try {
      const data = JSON.parse(payload);
      state.x = parseNumber(data.x, state.x);
      state.y = parseNumber(data.y, state.y);
      state.z = parseNumber(data.z, state.z);
      state.vibration = parseNumber(data.vibration, state.vibration);
      state.soil = Math.round(parseNumber(data.soil, state.soil));
      state.rain = Math.round(parseNumber(data.rain, state.rain));
      state.level = clampLevel(data.level);
      state.status = typeof data.status === "string" ? data.status : LEVEL_LABELS[state.level];
      state.high = typeof data.high === "undefined" ? state.high : parseBoolean(data.high);
      state.message = typeof data.message === "string" ? data.message : state.message;
      state.mpuOk = typeof data.mpuOk === "undefined" ? state.mpuOk : parseBoolean(data.mpuOk);
      state.uptime = Math.max(0, Math.round(parseNumber(data.uptime, state.uptime)));
      state.rssi = Math.round(parseNumber(data.rssi, state.rssi));
    } catch (error) {
      addEvent("system", "Payload telemetry tidak valid.");
    }
  }

  function setLevelClasses() {
    const cls = levelClass();
    els.levelValue.className = "metric-value " + cls;
    els.statusValue.className = "metric-value " + cls;
    els.highValue.className = "summary-value " + (isHighAlert() ? cls : "normal");
    els.levelCard.className = "metric-card";
    els.statusCard.className = "metric-card";

    if (state.level === 1) {
      els.levelCard.classList.add("warning");
      els.statusCard.classList.add("warning");
    } else if (state.level >= 2) {
      els.levelCard.classList.add("alerted");
      els.statusCard.classList.add("alerted");
    }
  }

  function renderDashboard() {
    setLevelClasses();

    els.xValue.innerHTML = formatAcceleration(state.x);
    els.yValue.innerHTML = formatAcceleration(state.y);
    els.zValue.innerHTML = formatAcceleration(state.z);
    els.vibrationValue.innerHTML = formatAcceleration(state.vibration);
    els.soilValue.textContent = state.soil + " ADC";
    els.rainValue.textContent = state.rain + " ADC";
    els.levelValue.textContent = String(state.level);
    els.statusValue.textContent = state.status || levelLabel();
    els.highValue.textContent = isHighAlert() ? "Aktif" : "Tidak aktif";
    els.lastUpdate.textContent = state.lastMessageAt ? formatClock(state.lastMessageAt) : "Belum ada data";
    els.dataAgeText.textContent = formatAge();
    els.deviceMeta.textContent =
      "Device: " +
      state.deviceStatus +
      " | IP " +
      state.deviceIp +
      " | RSSI " +
      state.rssi +
      " dBm | Up " +
      formatDuration(state.uptime);

    renderConclusion();
    renderAlert();
  }

  function renderConclusion() {
    if (!state.lastMessageAt) {
      els.conclusionText.textContent = "Menunggu data sensor dari MQTT.";
      return;
    }

    if (isStale()) {
      els.conclusionText.textContent =
        "Data belum diperbarui lebih dari 10 detik. Periksa koneksi broker, WiFi ESP32, dan daya sensor sebelum mengambil keputusan.";
      return;
    }

    if (state.mpuOk === false) {
      els.conclusionText.textContent =
        "MPU6050 tidak terbaca. Sistem menaikkan risiko agar operator memeriksa wiring dan kondisi perangkat.";
      return;
    }

    if (state.level === 0) {
      els.conclusionText.textContent =
        "Kondisi tanah dan getaran stabil. Tidak ada indikasi gempa atau longsor dari pembacaan terbaru.";
    } else if (state.level === 1) {
      els.conclusionText.textContent =
        "Ada kenaikan pembacaan sensor. Area perlu dipantau lebih dekat karena sistem berada pada status waspada.";
    } else if (state.level === 2) {
      els.conclusionText.textContent =
        "Alert high aktif. Getaran atau kondisi tanah masuk level bahaya dan area perlu segera diperiksa.";
    } else {
      els.conclusionText.textContent =
        "Level evakuasi aktif. Potensi bahaya tinggi, jalankan prosedur evakuasi dan amankan area.";
    }
  }

  function renderAlert() {
    const active = isHighAlert();
    els.criticalAlert.hidden = !active;

    if (!active) {
      currentAlertKey = "";
      alertAcknowledged = false;
      return;
    }

    const key = [state.level, state.status, state.message].join("|");
    if (key !== currentAlertKey) {
      currentAlertKey = key;
      alertAcknowledged = false;
      addEvent("alert", levelLabel() + ": " + state.message);
      playAlertTone();
    }

    els.criticalAlert.className =
      "critical-alert level-" + state.level + (alertAcknowledged ? " is-acknowledged" : "");
    els.criticalTitle.textContent = state.level >= 3 ? "EVAKUASI SEKARANG" : "ALERT TINGGI";
    els.criticalStatus.textContent = "Level " + state.level + " - " + (state.status || levelLabel());
    els.criticalTime.textContent = "Diterima " + formatClock(state.lastMessageAt || Date.now());
    els.criticalMessage.textContent = state.message || "Status bahaya diterima dari perangkat.";
  }

  function initChart() {
    if (typeof Chart === "undefined") {
      addEvent("system", "chart.js gagal dimuat.");
      return;
    }

    const ctx = document.getElementById("accelChart");
    accelChart = new Chart(ctx, {
      type: "line",
      data: {
        labels: [],
        datasets: [
          makeDataset("X Axis", "#1d4ed8"),
          makeDataset("Y Axis", "#15803d"),
          makeDataset("Z Axis", "#a16207"),
          makeDataset("Getaran", "#b91c1c"),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: {
          intersect: false,
          mode: "index",
        },
        plugins: {
          legend: {
            labels: {
              color: "#2f3a45",
              usePointStyle: true,
              boxWidth: 8,
              font: {
                family: "Ubuntu Local",
              },
            },
          },
          tooltip: {
            bodyFont: {
              family: "Ubuntu Local",
            },
            titleFont: {
              family: "Ubuntu Local",
            },
          },
        },
        scales: {
          x: {
            ticks: {
              color: "#65717f",
              maxRotation: 0,
              autoSkip: true,
              font: {
                family: "Ubuntu Local",
              },
            },
            grid: { color: "rgba(101, 113, 127, 0.12)" },
          },
          y: {
            ticks: {
              color: "#65717f",
              font: {
                family: "Ubuntu Local",
              },
            },
            grid: { color: "rgba(101, 113, 127, 0.12)" },
          },
        },
      },
    });
  }

  function makeDataset(label, color) {
    return {
      label,
      data: [],
      borderColor: color,
      backgroundColor: hexToRgba(color, 0.12),
      tension: 0.25,
      pointRadius: 0,
      borderWidth: 2,
    };
  }

  function hexToRgba(hex, alpha) {
    const value = hex.replace("#", "");
    const r = Number.parseInt(value.slice(0, 2), 16);
    const g = Number.parseInt(value.slice(2, 4), 16);
    const b = Number.parseInt(value.slice(4, 6), 16);
    return "rgba(" + r + ", " + g + ", " + b + ", " + alpha + ")";
  }

  function appendChartSample() {
    if (!accelChart || !state.lastMessageAt || isStale()) return;

    accelChart.data.labels.push(formatClock(Date.now()));
    accelChart.data.datasets[0].data.push(state.x);
    accelChart.data.datasets[1].data.push(state.y);
    accelChart.data.datasets[2].data.push(state.z);
    accelChart.data.datasets[3].data.push(state.vibration);

    if (accelChart.data.labels.length > MAX_CHART_SAMPLES) {
      accelChart.data.labels.shift();
      accelChart.data.datasets.forEach((dataset) => dataset.data.shift());
    }

    accelChart.update("none");
  }

  function addEvent(type, text) {
    const last = events[0];
    if (last && last.type === type && last.text === text && Date.now() - last.timestamp < 1500) {
      return;
    }

    events.unshift({
      type,
      text,
      timestamp: Date.now(),
    });

    if (events.length > 20) events.pop();
    renderEvents();
  }

  function renderEvents() {
    els.eventLog.replaceChildren();

    if (events.length === 0) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "Belum ada event.";
      els.eventLog.appendChild(empty);
      return;
    }

    events.forEach((event) => {
      const item = document.createElement("li");
      item.className = event.type;

      const time = document.createElement("time");
      time.textContent = formatClock(event.timestamp);

      const text = document.createElement("span");
      text.textContent = event.text;

      item.appendChild(time);
      item.appendChild(text);
      els.eventLog.appendChild(item);
    });
  }

  function playAlertTone() {
    if (!soundEnabled) return;

    try {
      if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }

      if (audioContext.state === "suspended") {
        audioContext.resume();
      }

      const start = audioContext.currentTime;
      [0, 0.16, 0.32].forEach((offset) => {
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        oscillator.type = "square";
        oscillator.frequency.setValueAtTime(state.level >= 3 ? 880 : 660, start + offset);
        gain.gain.setValueAtTime(0.0001, start + offset);
        gain.gain.exponentialRampToValueAtTime(0.18, start + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.12);
        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.start(start + offset);
        oscillator.stop(start + offset + 0.13);
      });
    } catch (error) {
      addEvent("system", "Audio browser tidak tersedia.");
    }
  }

  function bindUiEvents() {
    els.connectionForm.addEventListener("submit", (event) => {
      event.preventDefault();
      connectMqtt(els.brokerInput.value.trim() || DEFAULT_BROKER_URL);
    });

    els.soundButton.addEventListener("click", async () => {
      soundEnabled = !soundEnabled;
      els.soundButton.textContent = soundEnabled ? "Sound On" : "Sound Off";
      els.soundButton.setAttribute("aria-pressed", String(soundEnabled));

      if (soundEnabled) {
        try {
          if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
          }
          await audioContext.resume();
        } catch (error) {
          soundEnabled = false;
          els.soundButton.textContent = "Sound Off";
          els.soundButton.setAttribute("aria-pressed", "false");
          addEvent("system", "Audio browser tidak bisa diaktifkan.");
        }
      }
    });

    els.ackAlert.addEventListener("click", () => {
      alertAcknowledged = true;
      renderAlert();
    });
  }

  function boot() {
    collectElements();
    bindUiEvents();

    const initialBroker = readStoredBroker();
    els.brokerInput.value = initialBroker;
    els.brokerText.textContent = "Broker: " + initialBroker;

    initChart();
    connectMqtt(initialBroker);
    renderDashboard();

    setInterval(renderDashboard, 1000);
    setInterval(appendChartSample, 1000);
  }

  window.addEventListener("DOMContentLoaded", boot);
})();
