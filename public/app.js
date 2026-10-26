// ---------- Local storage (remembers your name and room so a reload rejoins) ----------
const Store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem("hide-and-seek:" + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem("hide-and-seek:" + key, JSON.stringify(value)); }
    catch (e) { console.warn("Could not save", e); }
  }
};

// ---------- "Install app" button (PC and Android) ----------
let deferredInstall = null;
const btnInstall = document.getElementById("btn-install");

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstall = e;
  if (btnInstall) btnInstall.hidden = false;
});

if (btnInstall) {
  btnInstall.addEventListener("click", async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    btnInstall.hidden = true;
  });
}

window.addEventListener("appinstalled", () => {
  if (btnInstall) btnInstall.hidden = true;
});

// ---------- Service worker (lets the app work offline) ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

// ---------- App logic ----------
const $ = (id) => document.getElementById(id);
const MIN = 60000;
let session = Store.get("session");          // { code, key }
let S = null;                                // last state from the server
let clockSkew = 0;                           // server time minus local time
let myPos = null;                            // latest GPS fix
let lastSent = 0;
let lastEventT = 0, lastRevealCount = null, lastPhase = null;
let wakeLock = null;

// ----- server calls -----
async function api(action, body = {}) {
  const res = await fetch("api/" + action, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: session && session.code, key: session && session.key, ...body })
  });
  const data = await res.json().catch(() => ({ error: "Server sent a bad reply." }));
  if (res.status === 410) { leaveLocal(); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || "Request failed.");
  return data;
}
function apply(state) {
  if (!state || !state.phase) return;
  clockSkew = state.now - Date.now();
  S = state;
  render();
}
const now = () => Date.now() + clockSkew;

function toast(msg, ms = 3200) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}
function buzz(p) { if (navigator.vibrate) navigator.vibrate(p); }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fmtClock(ms) {
  ms = Math.max(0, ms);
  const s = Math.ceil(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0");
}
const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + " km" : Math.round(m) + " m");
const ago = (t) => { const m = Math.floor((now() - t) / MIN); return m < 1 ? "just now" : m + " min ago"; };
const hhmm = (t) => new Date(t - clockSkew).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function distM(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ----- screens -----
function show(id) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== id;
  if (id === "game") keepAwake(); else releaseAwake();
  setTimeout(() => { for (const m of [lobbyMap, gameMap, overMap]) if (m) m.invalidateSize(); }, 50);
}

// ----- home -----
$("in-name").value = Store.get("name", "");
const params = new URLSearchParams(location.search);
if (params.get("room")) $("in-code").value = params.get("room").toUpperCase();

function needName() {
  const n = $("in-name").value.trim();
  if (!n) { toast("Put your name in first."); $("in-name").focus(); return null; }
  Store.set("name", n);
  return n;
}
$("btn-create").onclick = async () => {
  const name = needName(); if (!name) return;
  try { startSession(await api("create", { name, settings: Store.get("settings") || undefined })); }
  catch (e) { toast(e.message); }
};
$("btn-join").onclick = async () => {
  const name = needName(); if (!name) return;
  const code = $("in-code").value.trim().toUpperCase();
  if (code.length !== 5) return toast("Room codes have 5 characters.");
  try { session = null; startSession(await api("join", { name, code })); }
  catch (e) { toast(e.message); }
};
$("in-code").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btn-join").click(); });

function startSession({ code, key }) {
  session = { code, key };
  Store.set("session", session);
  history.replaceState(null, "", location.pathname);
  startGps();
  poll();
}
function leaveLocal() {
  session = null; S = null; lastPhase = null;
  Store.set("session", null);
  show("home");
}
async function leave() {
  if (!confirm("Leave this room?")) return;
  try { await api("leave"); } catch (e) {}
  leaveLocal();
}
$("btn-leave").onclick = leave;
$("btn-leave2").onclick = leave;

// ----- polling and GPS -----
let pollTimer = null;
async function poll() {
  clearTimeout(pollTimer);
  if (!session) return;
  try { apply(await api("state")); } catch (e) { if (session) $("gps-badge").textContent = "OFFLINE"; }
  if (session) pollTimer = setTimeout(poll, 2000);
}

let gpsWatch = null;
function startGps() {
  if (gpsWatch !== null || !("geolocation" in navigator)) {
    if (!("geolocation" in navigator)) toast("This device has no location. You can't play as a runner.");
    return;
  }
  gpsWatch = navigator.geolocation.watchPosition(
    (p) => {
      myPos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
      setGps("ok", "GPS ±" + Math.round(myPos.acc) + "m");
      if (Date.now() - lastSent > 4000) sendPos();
      if (S) renderMapsLive();
    },
    (err) => {
      setGps("bad", err.code === 1 ? "GPS BLOCKED" : "NO GPS");
      if (err.code === 1) toast("Location is blocked. Allow it in your browser settings or you can't play.", 6000);
    },
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 }
  );
}
function setGps(cls, text) { const b = $("gps-badge"); b.className = "badge gps " + cls; b.textContent = text; }
async function sendPos() {
  if (!myPos || !session) return;
  lastSent = Date.now();
  try { apply(await api("loc", myPos)); } catch (e) {}
}
// keep the server fresh even when standing still
setInterval(() => { if (myPos && Date.now() - lastSent > 12000) sendPos(); }, 3000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { poll(); sendPos(); if (S && (S.phase === "hiding" || S.phase === "hunting")) keepAwake(); }
});

async function keepAwake() {
  try { if ("wakeLock" in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => (wakeLock = null)); } } catch (e) {}
}
function releaseAwake() { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }

// ----- maps -----
const TILES = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
function makeMap(el, opts = {}) {
  const m = L.map(el, { zoomControl: false, attributionControl: true, ...opts }).setView([20, 0], 2);
  L.tileLayer(TILES, { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(m);
  return m;
}
const pin = (cls, size = 16) => L.divIcon({ className: "", html: `<div class="pin ${cls}" style="width:${size}px;height:${size}px"></div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
function setMarker(map, store, key, pos, cls, label) {
  if (!pos) { if (store[key]) { map.removeLayer(store[key]); delete store[key]; } return; }
  if (!store[key]) {
    store[key] = L.marker([pos.lat, pos.lng], { icon: pin(cls), interactive: false }).addTo(map);
    if (label) store[key].bindTooltip(label, { permanent: true, direction: "top", offset: [0, -8], className: "lbl" });
  } else {
    store[key].setLatLng([pos.lat, pos.lng]).setIcon(pin(cls));
    if (label) store[key].setTooltipContent(label);
  }
}
function setCircle(map, store, key, z, style) {
  if (!z) { if (store[key]) { map.removeLayer(store[key]); delete store[key]; } return; }
  if (!store[key]) store[key] = L.circle([z.lat, z.lng], { radius: z.r, interactive: false, ...style }).addTo(map);
  else store[key].setLatLng([z.lat, z.lng]).setRadius(z.r);
}
const ZONE = { color: "#ffb020", weight: 3, fillColor: "#ffb020", fillOpacity: 0.06 };
const NEXT = { color: "#ffffff", weight: 2, dashArray: "8 8", fill: false, opacity: 0.8 };

// lobby map: host taps to set the zone center
let lobbyMap = null; const lobbyL = {}; let lobbyFitted = false;
function ensureLobbyMap() {
  if (lobbyMap) return;
  lobbyMap = makeMap("lobby-map");
  lobbyMap.on("click", async (e) => {
    if (!S || !S.me.host) return;
    try { apply(await api("settings", { center: { lat: e.latlng.lat, lng: e.latlng.lng } })); } catch (err) { toast(err.message); }
  });
}
$("btn-center-me").onclick = async () => {
  if (!myPos) return toast("No GPS fix yet. Give it a second.");
  try { apply(await api("settings", { center: null })); lobbyFitted = false; } catch (e) { toast(e.message); }
};

// game map
let gameMap = null; const gameL = {}; let gameFitted = false;
function ensureGameMap() {
  if (gameMap) return;
  gameMap = makeMap("map");
  L.control.zoom({ position: "bottomright" }).addTo(gameMap);
}
$("btn-recenter").onclick = () => {
  if (myPos) gameMap.setView([myPos.lat, myPos.lng], Math.max(gameMap.getZoom(), 16));
  else if (gameL.zone) gameMap.fitBounds(gameL.zone.getBounds(), { padding: [20, 20] });
};

let overMap = null; const overL = {}; let overFitted = false;

// ----- render -----
function render() {
  const phase = S.phase;
  const screen = phase === "lobby" ? "lobby" : phase === "over" ? "over" : "game";
  if (phase !== lastPhase) {
    if (phase === "hiding") { gameFitted = false; buzz([200, 100, 200]); toast(S.me.role === "hunter" ? "You're a HUNTER. Wait for the head start to end." : "You're a RUNNER. Go hide!", 5000); }
    if (phase === "hunting" && lastPhase === "hiding") { buzz([400]); toast(S.me.role === "hunter" ? "Go get them!" : "Hunters are loose!"); }
    if (phase === "lobby") lobbyFitted = false;
    if (phase === "over") overFitted = false;
    show(screen);
    lastPhase = phase;
  }
  // new events since last render become toasts
  const fresh = S.events.filter((e) => e.t > lastEventT);
  if (lastEventT && fresh.length && phase !== "lobby") toast(fresh[fresh.length - 1].text);
  if (S.events.length) lastEventT = S.events[S.events.length - 1].t;
  if (lastRevealCount !== null && S.revealCount > lastRevealCount) buzz(S.me.role === "hunter" ? [100, 60, 100, 60, 100] : [300]);
  lastRevealCount = S.revealCount;

  if (screen === "lobby") renderLobby();
  else if (screen === "game") renderGame();
  else renderOver();
}

function renderLobby() {
  ensureLobbyMap();
  $("lobby-code").textContent = S.code;
  $("lobby-count").textContent = S.players.length;
  $("lobby-players").innerHTML = S.players.map((p) => `
    <li><span class="dot ${p.online ? "" : "off"}"></span>
      <span class="name">${esc(p.name)}${p.id === S.me.id ? " (you)" : ""}<span class="sub">${p.online ? "online" : "offline"}</span></span>
      ${p.host ? '<span class="tagx">HOST</span>' : ""}
      ${S.me.host && p.id !== S.me.id ? `<button class="btn btn-small btn-alt" data-kick="${p.id}" style="background:#223041;color:#e8edf3">Remove</button>` : ""}
    </li>`).join("");

  const form = $("settings");
  for (const [k, v] of Object.entries(S.settings)) {
    const input = form.elements[k];
    if (!input) continue;
    input.disabled = !S.me.host;
    if (document.activeElement !== input) input.value = v;
  }
  $("btn-start").hidden = !S.me.host;
  $("btn-center-me").hidden = !S.me.host;
  $("wait-host").hidden = S.me.host;

  const host = S.players.find((p) => p.host);
  const center = S.center || (host && host.pos) || (S.me.host && myPos);
  $("center-hint").textContent = S.me.host
    ? (S.center ? "Pinned center. Tap the map to move it." : "Using your location. Tap the map to pin a different center.")
    : "The host picks where the zone is.";
  setCircle(lobbyMap, lobbyL, "zone", center ? { lat: center.lat, lng: center.lng, r: S.settings.zoneKm * 1000 } : null, ZONE);
  setMarker(lobbyMap, lobbyL, "c", center, "hunter");
  setMarker(lobbyMap, lobbyL, "me", myPos, "me");
  if (center && !lobbyFitted) { lobbyMap.fitBounds(lobbyL.zone.getBounds(), { padding: [10, 10] }); lobbyFitted = true; }
}

let settingsTimer = null;
$("settings").addEventListener("input", () => {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(async () => {
    const settings = {};
    for (const el of $("settings").elements) if (el.name && el.value !== "") settings[el.name] = Number(el.value);
    Store.set("settings", settings);
    try { apply(await api("settings", { settings })); } catch (e) { toast(e.message); }
  }, 500);
});
$("lobby-players").addEventListener("click", async (e) => {
  const id = e.target.dataset.kick;
  if (!id) return;
  try { apply(await api("kick", { target: id })); } catch (err) { toast(err.message); }
});
$("btn-start").onclick = async () => {
  const ok = !S.center && !myPos ? false : true;
  if (!ok) return toast("No zone center yet. Tap the map or wait for GPS.");
  try { apply(await api("start")); } catch (e) { toast(e.message); }
};
$("btn-share").onclick = async () => {
  const url = location.origin + location.pathname + "?room=" + S.code;
  const text = `Join my Hide and Seek game. Code ${S.code}`;
  try {
    if (navigator.share) await navigator.share({ title: "Hide and Seek", text, url });
    else { await navigator.clipboard.writeText(text + " " + url); toast("Invite copied."); }
  } catch (e) {}
};

// role badge, countdowns and zone warning: redrawn every second
function renderHud() {
  const me = S.me, t = now(), hunter = me.role === "hunter";
  const badge = $("role-badge");
  badge.textContent = !me.alive ? (me.outReason === "zone" ? "DISQUALIFIED" : "CAUGHT") : hunter ? "HUNTER" : "RUNNER";
  badge.className = "badge " + (!me.alive ? "out" : hunter ? "hunter" : "");

  // timers
  const timers = [];
  if (S.phase === "hiding") timers.push([hunter ? "You hunt in" : "Hunters out in", S.huntAt - t, true]);
  if (S.phase === "hunting") {
    if (S.nextRevealAt <= S.endAt) timers.push([hunter ? "Next reveal" : "You get revealed", S.nextRevealAt - t, S.nextRevealAt - t < 30000]);
    if (S.nextShrinkAt <= S.endAt) timers.push(["Zone shrinks", S.nextShrinkAt - t, S.nextShrinkAt - t < 30000]);
  }
  timers.push(["Game ends", S.endAt - t, false]);
  $("timers").innerHTML = timers.map(([l, ms, hot]) => `<div class="timer ${hot ? "hot" : ""}"><small>${l}</small><b>${fmtClock(ms)}</b></div>`).join("")
    + `<div class="timer"><small>Zone</small><b>${fmtDist(S.zone.r)}</b></div>`;

  // out-of-zone warning (server is the judge; local GPS gives the instant distance)
  const warn = $("warn");
  if (!hunter && me.alive) {
    const pos = myPos || (S.players.find((p) => p.id === me.id) || {}).pos;
    const d = pos ? distM(pos, S.zone) - S.zone.r : -1;
    if (me.outSince || d > 0) {
      const left = me.outSince ? S.settings.graceMin * MIN - (t - me.outSince) : S.settings.graceMin * MIN;
      warn.hidden = false;
      warn.className = "warn" + (left < 60000 ? " danger" : "");
      warn.textContent = `OUTSIDE THE ZONE${d > 0 ? " by " + fmtDist(d) : ""}. Get back in: ${fmtClock(left)}`;
    } else warn.hidden = true;
  } else if (!me.alive) {
    warn.hidden = false; warn.className = "warn danger";
    warn.textContent = me.outReason === "zone" ? "You were disqualified for staying outside the zone." : "You were caught. Watch the rest play out.";
  } else warn.hidden = true;
}

function renderGame() {
  ensureGameMap();
  renderHud();
  renderMapsLive();
  const me = S.me, hunter = me.role === "hunter";
  const list = S.players.slice().sort((a, b) => (a.role === b.role ? 0 : a.role === "hunter" ? -1 : 1));
  $("game-players").innerHTML = list.map((p) => {
    const out = p.role === "runner" && !p.alive;
    const sub = p.role === "hunter" ? "hunter" : out ? (p.outReason === "zone" ? "disqualified (zone)" : "caught") : p.outSince ? "outside the zone!" : "still hiding";
    const canCatch = S.phase === "hunting" && p.role === "runner" && p.alive && (hunter || me.host) && p.id !== me.id;
    return `<li><span class="dot ${p.role === "hunter" ? "hunter" : out ? "out" : ""} ${p.online ? "" : "off"}"></span>
      <span class="name">${esc(p.name)}${p.id === me.id ? " (you)" : ""}<span class="sub">${sub}${p.online ? "" : " · offline"}</span></span>
      ${p.role === "hunter" ? '<span class="tagx hunter">HUNTER</span>' : out ? '<span class="tagx out">OUT</span>' : p.outSince ? '<span class="tagx warn">ZONE</span>' : ""}
      ${canCatch ? `<button class="btn" data-catch="${p.id}">Caught</button>` : ""}</li>`;
  }).join("");
  $("btn-gotcaught").hidden = hunter || !me.alive || S.phase !== "hunting";
  $("btn-end").hidden = !me.host;
  $("feed").innerHTML = S.events.slice().reverse().map((e) => `<li><time>${hhmm(e.t)}</time>${esc(e.text)}</li>`).join("");
}

// map layers that should follow GPS instantly, not just on poll
function renderMapsLive() {
  if (!S) return;
  if (S.phase === "lobby") return renderLobbyMarkersOnly();
  if (S.phase === "over" || !gameMap) return;
  setCircle(gameMap, gameL, "zone", S.zone, ZONE);
  setCircle(gameMap, gameL, "next", S.phase === "hunting" && S.nextShrinkAt <= S.endAt && S.nextZone.r < S.zone.r ? S.nextZone : null, NEXT);
  setMarker(gameMap, gameL, "me", myPos, "me");
  // hunters see teammates live and the latest reveal
  const shown = new Set();
  if (S.me.role === "hunter") {
    for (const p of S.players) if (p.role === "hunter" && p.id !== S.me.id && p.pos) { setMarker(gameMap, gameL, "h" + p.id, p.pos, "hunter", esc(p.name)); shown.add("h" + p.id); }
    const last = S.reveals[S.reveals.length - 1];
    if (last) for (const s of last.spots) {
      const p = S.players.find((x) => x.id === s.id);
      if (!p || !p.alive) continue;
      const stale = now() - s.seenAt > 2 * MIN;
      setMarker(gameMap, gameL, "r" + s.id, s, "spot" + (stale ? " old" : ""), `${esc(s.name)} · ${ago(last.t)}${stale ? " (old fix)" : ""}`);
      shown.add("r" + s.id);
    }
  }
  for (const k of Object.keys(gameL)) if ((k[0] === "h" || k[0] === "r") && !shown.has(k)) { gameMap.removeLayer(gameL[k]); delete gameL[k]; }
  if (!gameFitted && gameL.zone) { gameMap.fitBounds(gameL.zone.getBounds(), { padding: [20, 20] }); gameFitted = true; }
}
function renderLobbyMarkersOnly() { if (lobbyMap) setMarker(lobbyMap, lobbyL, "me", myPos, "me"); }

$("game-players").addEventListener("click", async (e) => {
  const id = e.target.dataset.catch;
  if (!id) return;
  const p = S.players.find((x) => x.id === id);
  if (!confirm(`Mark ${p ? p.name : "this runner"} as caught?`)) return;
  try { apply(await api("caught", { target: id })); buzz(200); } catch (err) { toast(err.message); }
});
$("btn-gotcaught").onclick = async () => {
  if (!confirm("Confirm you got caught? You'll be out.")) return;
  try { apply(await api("caught", { target: S.me.id })); } catch (e) { toast(e.message); }
};
$("btn-end").onclick = async () => {
  if (!confirm("End the game for everyone?")) return;
  try { apply(await api("end")); } catch (e) { toast(e.message); }
};
$("sheet-grab").onclick = () => $("sheet").classList.toggle("open");

function renderOver() {
  const b = $("over-banner");
  b.className = "card over-banner " + (S.winner || "");
  const last = S.events[S.events.length - 1];
  b.innerHTML = `<div class="big">${S.winner === "hunters" ? "HUNTERS WIN" : S.winner === "runners" ? "RUNNERS WIN" : "GAME ENDED"}</div><p class="muted">${esc(last ? last.text : "")}</p>`;
  $("over-players").innerHTML = S.players.map((p) => `
    <li><span class="dot ${p.role === "hunter" ? "hunter" : p.alive ? "" : "out"}"></span>
      <span class="name">${esc(p.name)}<span class="sub">${p.role === "hunter" ? "hunter" : p.alive ? "survived" : p.outReason === "zone" ? "disqualified (zone)" : "caught"}</span></span></li>`).join("");
  $("btn-again").hidden = !S.me.host;
  $("wait-again").hidden = S.me.host;
  if (!overMap) overMap = makeMap("over-map");
  setCircle(overMap, overL, "zone", S.zone, ZONE);
  for (const p of S.players) setMarker(overMap, overL, "p" + p.id, p.pos, p.role === "hunter" ? "hunter" : "spot" + (p.alive ? "" : " old"), esc(p.name));
  if (overL.zone && !overFitted) { overMap.fitBounds(overL.zone.getBounds(), { padding: [20, 20] }); overFitted = true; }
}
$("btn-again").onclick = async () => { try { apply(await api("lobby")); } catch (e) { toast(e.message); } };

// tick the countdowns every second between polls
setInterval(() => { if (S && (S.phase === "hiding" || S.phase === "hunting") && gameMap) renderHud(); }, 1000);

// ----- boot -----
if (session) { startGps(); poll(); } else show("home");
