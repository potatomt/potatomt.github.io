/* SmartGuard 32 dashboard - program
   The page listens to the ESP32 over MQTT and redraws itself when a message comes.

   Order: 1 helpers and memory     2 theme            3 views (#events, #settings)
          4 MQTT (connect, send)   5 online chip      6 dashboard (security, tiles, light)
          7 chart                  8 events           9 PIN sheet
          10 settings              11 start

   CONFIG comes from config.js. The mqtt object comes from MQTT.js (loaded in index.html). */
"use strict";

// ---------- 1. Helpers and memory ----------
const $ = (id) => document.getElementById(id);          // short way to find an element

const BASE = "sg/" + CONFIG.DEVICE_ID;                   // all topics start with this
const NO_ANSWER = "No answer from the device";
const REPLY_WAIT = 5000;                                 // ms to wait for a reply
const OFFLINE_AFTER = 10000;                             // ms without a state = offline

// Everything the page remembers. Nothing here is saved, and the PIN is never kept.
const app = {
  state: null,              // last "state" message from the device
  hist: { t: [], h: [] },   // last "hist" message
  events: [],               // last "events" message
  brokerUp: false,          // are we connected to the MQTT broker?
  deviceUp: true,           // the "online" topic ("1" or "0")
  lastSeen: 0,              // when the last state was made (ms)
  startedAt: Date.now(),
  armingEnds: null,         // when the arming countdown ends (ms), 0 = unknown
  lockUntil: 0,             // when the PIN lockout ends (ms)
  chartTab: "t",            // "t" or "h"
  chartDrawn: false,
  filter: "all",            // events filter
  dragging: {},             // sliders the user is moving right now
};

function isOnline() {
  return app.brokerUp && app.deviceUp && app.state !== null &&
         Date.now() - app.lastSeen < OFFLINE_AFTER;
}

function secondsLeft(untilMs) {
  return Math.max(0, Math.ceil((untilMs - Date.now()) / 1000));
}

// Move a segmented control to `value` (the CSS slides the thumb using data-i)
function setSeg(seg, value) {
  const buttons = [...seg.querySelectorAll("button")];
  buttons.forEach((b) => b.setAttribute("aria-pressed", b.dataset.value === value));
  const i = buttons.findIndex((b) => b.dataset.value === value);
  if (i >= 0) seg.dataset.i = i; else delete seg.dataset.i;
}

let toastTimer;
function toast(text) {
  $("toast").textContent = text;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 3000);
}

// ---------- 2. Theme: System / Light / Dark, saved in localStorage ----------
const systemDark = matchMedia("(prefers-color-scheme: dark)");

function savedTheme() {
  try { return localStorage.getItem("sg-theme") || "system"; } catch (e) { return "system"; }
}

function applyTheme(choice) {
  const dark = choice === "dark" || (choice === "system" && systemDark.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelectorAll('[data-seg="theme"]').forEach((seg) => setSeg(seg, choice));
}

function chooseTheme(choice) {
  try { localStorage.setItem("sg-theme", choice); } catch (e) { /* private mode: not saved */ }
  applyTheme(choice);
}

systemDark.addEventListener("change", () => applyTheme(savedTheme()));

// ---------- 3. Views: one page, the part after # picks what is shown ----------
function showView() {
  const name = location.hash === "#events" ? "events"
             : location.hash === "#settings" ? "settings" : "dash";
  for (const v of ["dash", "events", "settings"]) $("view-" + v).hidden = v !== name;
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", showView);

// ---------- 4. MQTT ----------
let client = null;
const waiting = new Map();          // command id -> { resolve, timer }

function connect() {
  client = mqtt.connect("wss://" + CONFIG.MQTT_HOST + ":8084/mqtt", {
    username: "web",
    password: CONFIG.WEB_PASSWORD,
    clientId: "web-" + Math.random().toString(16).slice(2, 10),
    reconnectPeriod: 3000,          // try again every 3 s if the connection drops
    connectTimeout: 10000,
  });
  client.on("connect", () => {
    app.brokerUp = true;
    client.subscribe(["state", "hist", "events", "online", "reply"].map((t) => BASE + "/" + t));
    render();
  });
  client.on("close", () => { app.brokerUp = false; render(); });
  client.on("error", (err) => console.warn("MQTT:", err.message));
  client.on("message", onMessage);
}

function onMessage(topic, payload, packet) {
  let data;
  try { data = JSON.parse(payload.toString()); } catch (e) { return; }   // not JSON: ignore
  const name = topic.slice(BASE.length + 1);

  if (name === "state" && data && typeof data === "object") {
    gotState(data, packet.retain);
  } else if (name === "hist" && data && Array.isArray(data.t) && Array.isArray(data.h)) {
    app.hist = data;
    drawChart();
  } else if (name === "events" && Array.isArray(data)) {
    app.events = data;
    drawEvents();
  } else if (name === "online") {
    app.deviceUp = String(data) === "1";
    render();
  } else if (name === "reply" && data) {
    const w = waiting.get(String(data.id));        // match the reply to its command
    if (w) {
      clearTimeout(w.timer);
      waiting.delete(String(data.id));
      w.resolve({ ok: !!data.ok, msg: String(data.msg || "") });
    }
  }
}

function gotState(s, retained) {
  const before = app.state;
  app.state = s;
  // A "retained" message is an old copy kept by the broker, so use its own
  // time stamp. A live message was made just now.
  app.lastSeen = retained ? Math.min(Date.now(), s.ts * 1000) : Date.now();

  // Arming countdown: the device does not send the seconds left, so we start
  // our own count when we see the state change to "arming".
  if (s.sec !== "arming") app.armingEnds = null;
  else if (app.armingEnds === null) {
    app.armingEnds = before && before.sec !== "arming" ? Date.now() + s.delay * 1000 : 0;
  }
  app.lockUntil = Date.now() + (s.lock || 0) * 1000;
  render();
}

// Send a command. Always gives back { ok, msg }, also when nothing answers.
function send(cmd, wait = REPLY_WAIT) {
  return new Promise((resolve) => {
    if (!client || !app.brokerUp) return resolve({ ok: false, msg: NO_ANSWER });
    const id = Math.random().toString(36).slice(2, 10);
    const timer = setTimeout(() => {
      waiting.delete(id);
      resolve({ ok: false, msg: NO_ANSWER });
    }, wait);
    waiting.set(id, { resolve, timer });
    client.publish(BASE + "/cmd", JSON.stringify({ id, ...cmd }));
  });
}

// Send a command and show its answer as a short message
async function run(cmd, wait) {
  const reply = await send(cmd, wait);
  toast(reply.msg);
  return reply;
}

// ---------- 5. Online chip ----------
function clockText(ms) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const today = d.toDateString() === new Date().toDateString();
  return today ? time : d.toLocaleDateString([], { day: "numeric", month: "short" }) + " " + time;
}

function drawChip() {
  const online = isOnline();
  let text;
  if (online) {
    text = "Online · updated " + Math.round((Date.now() - app.lastSeen) / 1000) + " s ago";
  } else if (!app.lastSeen && Date.now() - app.startedAt < OFFLINE_AFTER) {
    text = "Connecting…";
  } else {
    text = "Offline · last seen " + (app.lastSeen ? clockText(app.lastSeen) : "never");
  }
  $("chip-text").textContent = text;
  $("chip").className = "chip" + (online ? " online" : text.startsWith("Offline") ? " offline" : "");

  // Offline: grey out the values and switch off every button that sends a command
  document.body.classList.toggle("offline", !online);
  document.querySelectorAll("[data-cmd]").forEach((el) => { el.disabled = !online; });
}

// ---------- 6. Dashboard: security card, tiles, room light ----------
function drawSecurity(s) {
  const pin = !!s.pin;
  let word, text;
  if (s.sec === "disarmed") {
    word = "Disarmed"; text = "The room is not being watched.";
  } else if (s.sec === "arming") {
    word = "Arming";
    text = app.armingEnds ? "Leave the room. Arming in " + secondsLeft(app.armingEnds) + " s."
                          : "Leave the room. Arming soon.";
  } else if (s.sec === "armed") {
    word = "Armed"; text = "Watching for motion and the door since " + s.since + ".";
  } else if (s.sec === "alarm") {
    word = "Alarm!"; text = "Something was detected at " + s.since + ". The buzzer is on.";
  } else {
    word = "Silenced"; text = "The buzzer is off. The alarm stays until you disarm.";
  }
  if ($("sec-word").textContent !== word) $("sec-word").textContent = word;
  $("sec-text").textContent = text;
  $("sec-card").className = "card sec is-" + s.sec;

  $("btn-arm").hidden = s.sec !== "disarmed";
  $("btn-silence").hidden = s.sec !== "alarm";
  $("btn-disarm").hidden = s.sec === "disarmed";
  $("sec-note").textContent = !pin ? "No PIN set. You can add one in Settings."
    : s.sec === "alarm" ? "Silence needs no PIN · Disarm needs your PIN" : "PIN required";
}

function drawTiles(s) {
  $("v-t").textContent = s.t === null ? "—" : Number(s.t).toFixed(1);
  $("v-h").textContent = s.h === null ? "—" : s.h;
  $("v-dark").textContent = s.dark ? "Dark" : "Bright";
  $("v-motion").textContent = s.motion ? "Detected" : "Clear";
  $("v-door").textContent = s.door ? "Blocked" : "Clear";
  $("v-motion").classList.toggle("alert", !!s.motion);
  $("v-door").classList.toggle("alert", !!s.door);
}

function drawLight(s) {
  $("light-word").textContent = s.lon ? "On" : "Off";
  $("light-status").classList.toggle("on", !!s.lon);
  setSeg(document.querySelector('[data-seg="light"]'), s.light);
  if (!app.dragging.bri) {                // do not fight the user's finger
    $("bri").value = s.bri;
    $("bri-val").textContent = s.bri + "%";
  }
  $("light-note").textContent =
      s.light === "off" ? "The light stays off."
    : s.light === "on"  ? "The light stays on at " + s.bri + "% brightness."
    : "Turns on when it is dark and something moves, then stays on for " + s.hold + " s.";
}

function sendLight(mode) {
  run({ do: "light", mode: mode, bri: Number($("bri").value) });
}

// Arm / Disarm: ask for the PIN first, but only if the device has one
function armOrDisarm(what) {
  if (app.state && app.state.pin) openSheet(what);
  else run({ do: what });
}

// A slider shows its number while moving and sends only when released
function wireSlider(id, unit, onRelease) {
  const input = $(id);
  input.addEventListener("input", () => {
    app.dragging[id] = true;
    $(id + "-val").textContent = input.value + unit;
  });
  input.addEventListener("change", () => {
    app.dragging[id] = false;
    onRelease(Number(input.value));
  });
}

// ---------- 7. Chart ----------
// One sample per minute, oldest first. The newest sample sits at the right edge ("Now").
// The SVG is 100 x 100 units and is stretched to the size of the plot box.
const SLOTS = 30;
let chartPoints = [];        // [{ x, y, value, ago }] with x and y in percent

function chartUnit(v) {
  return app.chartTab === "t" ? Number(v).toFixed(1) + " °C" : v + " %";
}

function drawChart(animate) {
  const data = app.hist[app.chartTab].slice(-SLOTS);
  const plot = $("plot");
  plot.classList.toggle("hum", app.chartTab === "h");
  $("plot-empty").hidden = data.length > 0;
  hideCross();

  if (!data.length) {
    chartPoints = [];
    $("plot-line").setAttribute("d", "");
    $("plot-area").setAttribute("d", "");
    for (const id of ["y-max", "y-mid", "y-min"]) $(id).textContent = "";
    return;
  }

  // Y axis: one unit of free space above and below the data
  const low = Math.floor(Math.min(...data)) - 1;
  const high = Math.ceil(Math.max(...data)) + 1;
  $("y-max").textContent = high;
  $("y-mid").textContent = (low + high) / 2;
  $("y-min").textContent = low;

  chartPoints = data.map((value, i) => {
    const ago = data.length - 1 - i;                       // minutes ago
    return {
      value, ago,
      x: (100 * (SLOTS - 1 - ago)) / (SLOTS - 1),
      y: (100 * (high - value)) / (high - low),
    };
  });

  const first = chartPoints[0], last = chartPoints[chartPoints.length - 1];
  let line = chartPoints.map((p, i) => (i ? "L" : "M") + p.x.toFixed(2) + " " + p.y.toFixed(2)).join(" ");
  if (chartPoints.length === 1) line = "M" + (first.x - 1.5) + " " + first.y + " L" + first.x + " " + first.y;
  $("plot-line").setAttribute("d", line);
  $("plot-area").setAttribute("d", line + " L" + last.x + " 100 L" + first.x + " 100 Z");

  const name = app.chartTab === "t" ? "Temperature" : "Humidity";
  $("plot-svg").setAttribute("aria-label", name + " for the last " + data.length +
    " minutes: now " + chartUnit(last.value) + ", lowest " + chartUnit(Math.min(...data)) +
    ", highest " + chartUnit(Math.max(...data)));

  // Draw from left to right the first time and when the tab changes
  if (animate || !app.chartDrawn) {
    app.chartDrawn = true;
    plot.classList.remove("draw");
    void plot.offsetWidth;                // makes the browser restart the animation
    plot.classList.add("draw");
  }
}

// Crosshair: find the sample nearest to the mouse or finger
function moveCross(event) {
  if (!chartPoints.length) return;
  const box = $("plot").getBoundingClientRect();
  const percent = (100 * (event.clientX - box.left)) / box.width;
  let p = chartPoints[0];
  for (const q of chartPoints) if (Math.abs(q.x - percent) < Math.abs(p.x - percent)) p = q;

  $("cross-v").style.left = p.x + "%";
  $("cross-h").style.top = p.y + "%";
  $("cross-dot").style.left = $("tip").style.left = p.x + "%";
  $("cross-dot").style.top = $("tip").style.top = p.y + "%";
  $("tip").textContent = chartUnit(p.value) + " · " + (p.ago ? p.ago + " min ago" : "now");
  $("tip").className = "tip" + (p.x > 55 ? " left" : "") + (p.y < 25 ? " below" : "");
  for (const id of ["cross-v", "cross-h", "cross-dot", "tip"]) $(id).hidden = false;
}

function hideCross() {
  for (const id of ["cross-v", "cross-h", "cross-dot", "tip"]) $(id).hidden = true;
}

// ---------- 8. Events ----------
function eventRow(ev) {
  const li = document.createElement("li");
  li.className = ["alarm", "security", "light", "device"].includes(ev.kind) ? ev.kind : "device";
  const dot = document.createElement("span");
  dot.className = "dot";
  const text = document.createElement("span");
  text.className = "text";
  text.textContent = ev.text;             // textContent: event text is never run as HTML
  const time = document.createElement("time");
  time.textContent = ev.time;
  li.append(dot, text, time);
  return li;
}

function note(text) {
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = text;
  return p;
}

// "2026-11-15" -> "Today", "Yesterday" or "15 Nov 2026". The device uses Saudi time (UTC+3).
function dayName(day) {
  const saudiDay = (daysBack) =>
    new Date(Date.now() + 3 * 3600e3 - daysBack * 86400e3).toISOString().slice(0, 10);
  if (day === saudiDay(0)) return "Today";
  if (day === saudiDay(1)) return "Yesterday";
  const d = new Date(day + "T00:00:00");
  return isNaN(d) ? String(day)
    : d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

function drawEvents() {
  // Dashboard: the newest three
  const recent = app.events.slice(0, 3).map(eventRow);
  $("recent").replaceChildren(...(recent.length ? recent : [note("No events yet.")]));

  // All events: filtered, with a heading for each day
  const list = app.events.filter((ev) => app.filter === "all" || ev.kind === app.filter);
  const parts = [];
  let day = null, ul = null;
  for (const ev of list) {
    if (ev.day !== day) {
      day = ev.day;
      const h = document.createElement("h2");
      h.className = "day";
      h.textContent = dayName(day);
      ul = document.createElement("ul");
      ul.className = "events";
      parts.push(h, ul);
    }
    ul.append(eventRow(ev));
  }
  $("all-events").replaceChildren(...(parts.length ? parts : [note("No events of this kind yet.")]));
}

// ---------- 9. PIN sheet ----------
const sheet = { open: false, what: "arm", digits: "", busy: false, opener: null };

function openSheet(what) {
  sheet.open = true;
  sheet.what = what;
  sheet.digits = "";
  sheet.busy = false;
  sheet.opener = document.activeElement;
  $("sheet-title").textContent = "Enter PIN to " + what;
  $("sheet-msg").textContent = "";
  $("pin-overlay").hidden = false;
  $("page").inert = true;                 // the page behind cannot be clicked or tabbed to
  drawSheet();
  $("pin-sheet").focus();
}

function closeSheet() {
  sheet.open = false;
  sheet.digits = "";                      // forget the digits right away
  $("pin-overlay").hidden = true;
  $("page").inert = false;
  if (sheet.opener) sheet.opener.focus();
}

function drawSheet() {
  if (!sheet.open) return;
  const locked = secondsLeft(app.lockUntil);
  const n = sheet.digits.length;
  [...$("pin-dots").children].forEach((dot, i) => {
    dot.hidden = i >= Math.max(4, n);     // 4 dots, growing to 5 and 6
    dot.classList.toggle("on", i < n);
  });
  if (locked) {
    sheet.digits = "";
    $("sheet-msg").textContent = "Locked for " + locked + " s";
  } else if ($("sheet-msg").textContent.startsWith("Locked for")) {
    $("sheet-msg").textContent = "";
  }
  const off = locked > 0 || sheet.busy || !isOnline();
  document.querySelectorAll(".key").forEach((key) => { key.disabled = off; });
  $("sheet-done").disabled = off || n < 4;
}

function pressKey(key) {
  if (sheet.busy || secondsLeft(app.lockUntil) || !isOnline()) return;
  if (key === "back") sheet.digits = sheet.digits.slice(0, -1);
  else if (sheet.digits.length < 6) sheet.digits += key;
  $("sheet-msg").textContent = "";
  drawSheet();
  if (sheet.digits.length === 6) submitPin();       // 6 is the longest PIN: send at once
}

async function submitPin() {
  if (sheet.busy || sheet.digits.length < 4) return;
  sheet.busy = true;
  drawSheet();
  const reply = await send({ do: sheet.what, pin: sheet.digits });
  sheet.busy = false;
  sheet.digits = "";
  if (!sheet.open) return;                          // closed while waiting
  if (reply.ok) {
    closeSheet();
    toast(reply.msg);
    return;
  }
  $("sheet-msg").textContent = reply.msg;           // for example "Wrong PIN. 4 tries left"
  $("pin-dots").classList.add("shake");
  setTimeout(() => $("pin-dots").classList.remove("shake"), 450);
  drawSheet();
}

// Physical keyboard: digits, Backspace, Enter (send) and Escape (close)
document.addEventListener("keydown", (e) => {
  if (!sheet.open) return;
  if (/^[0-9]$/.test(e.key)) pressKey(e.key);
  else if (e.key === "Backspace") pressKey("back");
  else if (e.key === "Escape") closeSheet();
  else if (e.key === "Enter" && e.target.tagName !== "BUTTON" && e.target.tagName !== "A") submitPin();
});

// ---------- 10. Settings ----------
function upText(seconds) {
  const d = Math.floor(seconds / 86400), h = Math.floor(seconds / 3600) % 24,
        m = Math.floor(seconds / 60) % 60;
  if (d) return d + " d " + h + " h";
  if (h) return h + " h " + m + " min";
  return m ? m + " min" : seconds + " s";
}

function drawSettings(s) {
  $("pin-status").textContent = s.pin ? "On · PIN set" : "Off";
  $("pin-status").classList.toggle("on", !!s.pin);
  for (const id of ["hold", "delay"]) {
    if (app.dragging[id]) continue;
    $(id).value = s[id];
    $(id + "-val").textContent = s[id] + " s";
  }
  $("d-rssi").textContent = s.rssi ? s.rssi + " dBm" : "—";
  $("d-up").textContent = upText(s.up);
  $("d-ts").textContent = new Date(s.ts * 1000).toLocaleString([], {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function pinMessage(text, good) {
  $("pin-msg").textContent = text;
  $("pin-msg").classList.toggle("good", !!good);
}

// Used by "Save new PIN" and "Remove PIN". The fields are emptied after every try.
async function pinCommand(cmd) {
  pinMessage("");
  const reply = await send(cmd);
  for (const id of ["f-master", "f-pin", "f-pin2"]) $(id).value = "";
  pinMessage(reply.msg, reply.ok);
}

function savePin(event) {
  event.preventDefault();                 // do not reload the page
  const master = $("f-master").value, pin = $("f-pin").value;
  if (!master) return pinMessage("Type the master password.");
  if (!/^[0-9]{4,6}$/.test(pin)) return pinMessage("The PIN must be 4 to 6 digits.");
  if (pin !== $("f-pin2").value) return pinMessage("The two PINs do not match.");
  pinCommand({ do: "setpin", master: master, pin: pin });
}

function removePin() {
  const master = $("f-master").value;
  if (!master) {
    $("f-master").focus();
    return pinMessage("Type the master password to remove the PIN.");
  }
  pinCommand({ do: "delpin", master: master });
}

async function testAlert() {
  const button = $("btn-test");
  button.textContent = "Sending…";
  // The ESP32 answers only after ntfy has answered, which can take longer than 5 s
  await run({ do: "test_alert" }, 15000);
  button.textContent = "Send a test alert";
}

// ---------- 11. Start ----------
// render() redraws everything that depends on the state. It runs after every
// message and once a second (for "updated N s ago" and the countdowns).
function render() {
  drawChip();
  if (app.state) {
    drawSecurity(app.state);
    drawTiles(app.state);
    drawLight(app.state);
    drawSettings(app.state);
  }
  drawSheet();
}

function wireButtons() {
  // Segmented controls: theme (twice), chart tabs, light mode
  document.querySelectorAll(".seg").forEach((seg) => {
    seg.addEventListener("click", (e) => {
      const button = e.target.closest("button");
      if (!button) return;
      const value = button.dataset.value;
      if (seg.dataset.seg === "theme") chooseTheme(value);
      if (seg.dataset.seg === "light") { setSeg(seg, value); sendLight(value); }
      if (seg.dataset.seg === "chart") { app.chartTab = value; setSeg(seg, value); drawChart(true); }
    });
  });

  $("btn-arm").addEventListener("click", () => armOrDisarm("arm"));
  $("btn-disarm").addEventListener("click", () => armOrDisarm("disarm"));
  $("btn-silence").addEventListener("click", () => run({ do: "silence" }));   // no PIN, sent at once

  wireSlider("bri", "%", () => sendLight(app.state ? app.state.light : "auto"));
  wireSlider("hold", " s", (value) => run({ do: "set", hold: value }));
  wireSlider("delay", " s", (value) => run({ do: "set", delay: value }));

  // Chart crosshair: mouse hover, or a finger drag on a phone
  const plot = $("plot");
  plot.addEventListener("pointerdown", moveCross);
  plot.addEventListener("pointermove", moveCross);
  plot.addEventListener("pointerleave", hideCross);
  plot.addEventListener("pointercancel", hideCross);

  // Event filter chips
  $("filters").addEventListener("click", (e) => {
    const chip = e.target.closest("button");
    if (!chip) return;
    app.filter = chip.dataset.kind;
    for (const b of $("filters").children) b.setAttribute("aria-pressed", b === chip);
    drawEvents();
  });

  // PIN sheet
  $("keypad").addEventListener("click", (e) => {
    const key = e.target.closest(".key");
    if (key) pressKey(key.dataset.key);
  });
  $("sheet-done").addEventListener("click", submitPin);
  $("sheet-close").addEventListener("click", closeSheet);
  $("sheet-forgot").addEventListener("click", closeSheet);          // the link then opens #settings
  $("pin-overlay").addEventListener("click", (e) => { if (e.target === $("pin-overlay")) closeSheet(); });

  // Settings
  $("pin-form").addEventListener("submit", savePin);
  $("btn-delpin").addEventListener("click", removePin);
  $("btn-test").addEventListener("click", testAlert);
}

function start() {
  applyTheme(savedTheme());
  wireButtons();
  showView();
  drawEvents();
  drawChart();
  render();
  setInterval(render, 1000);

  // Connect only after config.js has been filled in
  const ready = [CONFIG.MQTT_HOST, CONFIG.DEVICE_ID, CONFIG.WEB_PASSWORD]
    .every((v) => v && !v.startsWith("YOUR_"));
  if (!ready) $("setup-banner").hidden = false;
  else if (typeof mqtt === "undefined") toast("Could not load MQTT.js");
  else connect();
}

start();
