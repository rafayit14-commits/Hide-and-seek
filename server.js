// Hide and Seek — game server. No dependencies: `node server.js`, then open http://localhost:8800
// Holds every room in memory and runs the clock: reveals, zone shrinks, disqualifications.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8800;
const PUBLIC = path.join(__dirname, "public");
const MIN = 60 * 1000;

const DEFAULTS = {
  hunters: 1,          // how many hunters get picked
  headStartMin: 5,     // runners hide, hunters wait
  revealEveryMin: 5,   // hunters get every runner's location this often
  zoneKm: 5,           // starting zone radius
  shrinkEveryMin: 5,   // zone shrinks this often
  shrinkPct: 25,       // each shrink removes this % of the radius
  minZoneM: 150,       // zone never gets smaller than this
  graceMin: 3,         // time a runner has to get back inside before being disqualified
  gameMin: 60          // runners still alive when this runs out win
};
const LIMITS = {
  hunters: [1, 20], headStartMin: [0, 60], revealEveryMin: [0.1, 120], zoneKm: [0.05, 100],
  shrinkEveryMin: [0.1, 120], shrinkPct: [1, 90], minZoneM: [10, 10000], graceMin: [0.1, 60], gameMin: [1, 1440]
};

const rooms = new Map();

// ---------- helpers ----------
const rid = (n) => crypto.randomBytes(n).toString("hex");
function roomCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c;
  do { c = Array.from({ length: 5 }, () => A[crypto.randomInt(A.length)]).join(""); } while (rooms.has(c));
  return c;
}
function distM(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// Move `m` meters from a point at a bearing (radians)
function offset(p, m, bearing) {
  const R = 6371000, r = Math.PI / 180, d = m / R;
  const lat1 = p.lat * r, lng1 = p.lng * r;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(bearing));
  const lng2 = lng1 + Math.atan2(Math.sin(bearing) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: lat2 / r, lng: lng2 / r };
}
// Next zone: smaller circle placed randomly but fully inside the current one
function nextZone(zone, s) {
  const r = Math.max(s.minZoneM, zone.r * (1 - s.shrinkPct / 100));
  if (r >= zone.r) return { ...zone };
  const slack = zone.r - r;
  const c = offset(zone, slack * Math.sqrt(Math.random()), Math.random() * 2 * Math.PI);
  return { lat: c.lat, lng: c.lng, r };
}
function cleanSettings(input, base) {
  const s = { ...base };
  for (const k of Object.keys(DEFAULTS)) {
    const v = Number(input && input[k]);
    if (input && input[k] !== undefined && Number.isFinite(v)) s[k] = Math.min(LIMITS[k][1], Math.max(LIMITS[k][0], v));
  }
  s.hunters = Math.round(s.hunters);
  return s;
}
const validPos = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
const runners = (room) => [...room.players.values()].filter((p) => p.role === "runner");

function log(room, text, t = Date.now()) {
  room.events.push({ t, text });
  if (room.events.length > 100) room.events.shift();
}

// ---------- game clock ----------
function tick(room, now = Date.now()) {
  if (room.phase !== "hiding" && room.phase !== "hunting") return;
  const s = room.settings;

  if (room.phase === "hiding" && now >= room.huntAt) {
    room.phase = "hunting";
    room.nextRevealAt = room.huntAt + s.revealEveryMin * MIN;
    room.nextShrinkAt = room.huntAt + s.shrinkEveryMin * MIN;
    log(room, "Hunters released. The hunt is on.", room.huntAt);
  }

  if (room.phase === "hunting") {
    while (now >= room.nextRevealAt && room.nextRevealAt <= room.endAt) {
      const at = room.nextRevealAt;
      room.reveals.push({
        t: at,
        spots: runners(room).filter((p) => p.alive && p.pos).map((p) => ({ id: p.id, name: p.name, lat: p.pos.lat, lng: p.pos.lng, seenAt: p.posAt }))
      });
      if (room.reveals.length > 50) room.reveals.shift();
      log(room, "Runner locations sent to the hunters.", at);
      room.nextRevealAt += s.revealEveryMin * MIN;
    }
    while (now >= room.nextShrinkAt && room.nextShrinkAt <= room.endAt) {
      const at = room.nextShrinkAt;
      room.zone = room.nextZone;
      room.nextZone = nextZone(room.zone, s);
      log(room, `Zone shrank to ${fmtDist(room.zone.r)}. Get inside.`, at);
      // Everyone caught outside starts the grace clock from the moment of the shrink
      for (const p of runners(room)) if (p.alive && p.pos && distM(p.pos, room.zone) > room.zone.r && !p.outSince) p.outSince = at;
      room.nextShrinkAt += s.shrinkEveryMin * MIN;
    }
  }

  // Zone enforcement (also during hiding, against the starting zone)
  for (const p of runners(room)) {
    if (!p.alive || !p.pos) continue;
    const outside = distM(p.pos, room.zone) > room.zone.r;
    if (!outside) p.outSince = null;
    else if (!p.outSince) p.outSince = now;
    else if (now - p.outSince >= s.graceMin * MIN) {
      p.alive = false; p.outReason = "zone"; p.outAt = now;
      log(room, `${p.name} stayed outside the zone and is disqualified.`);
    }
  }

  const alive = runners(room).filter((p) => p.alive);
  if (alive.length === 0) finish(room, "hunters", "Every runner is out. Hunters win.");
  else if (now >= room.endAt) finish(room, "runners", `Time's up. ${alive.map((p) => p.name).join(", ")} survived. Runners win.`);
}
function finish(room, winner, text) {
  room.phase = "over"; room.winner = winner; room.endedAt = Date.now();
  log(room, text);
}
const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + " km" : Math.round(m) + " m");

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    tick(room, now);
    if (now - room.touchedAt > 6 * 60 * MIN) rooms.delete(code);
  }
}, 1000);

// ---------- what each player is allowed to see ----------
function view(room, me) {
  const now = Date.now();
  const iHunt = me.role === "hunter";
  const over = room.phase === "over";
  const players = [...room.players.values()].map((p) => {
    const o = { id: p.id, name: p.name, role: p.role, alive: p.alive, host: p.id === room.hostId, outReason: p.outReason || null, online: now - p.seenAt < 20000 };
    const showLive = p.id === me.id || over || (iHunt && p.role === "hunter");
    if (showLive && p.pos) { o.pos = p.pos; o.posAt = p.posAt; }
    if (p.id === me.id || (iHunt && p.role === "runner") || over) o.outSince = p.outSince;
    return o;
  });
  return {
    now, code: room.code, phase: room.phase, winner: room.winner || null,
    settings: room.settings, center: room.center,
    me: { id: me.id, name: me.name, role: me.role, alive: me.alive, host: me.id === room.hostId, outSince: me.outSince, outReason: me.outReason || null },
    players,
    zone: room.zone || null, nextZone: room.nextZone || null,
    huntAt: room.huntAt || null, endAt: room.endAt || null,
    nextRevealAt: room.phase === "hunting" ? room.nextRevealAt : null,
    nextShrinkAt: room.phase === "hunting" ? room.nextShrinkAt : null,
    reveals: iHunt || over ? room.reveals.slice(-10) : [],
    revealCount: room.reveals.length,
    events: room.events.slice(-30)
  };
}

// ---------- actions ----------
function addPlayer(room, name) {
  const p = { id: rid(4), key: rid(16), name: String(name || "").trim().slice(0, 20) || "Player", role: "runner", alive: true, pos: null, posAt: 0, seenAt: Date.now(), outSince: null };
  room.players.set(p.key, p);
  return p;
}
function resetPlayers(room) {
  for (const p of room.players.values()) Object.assign(p, { role: "runner", alive: true, outSince: null, outReason: null, outAt: null });
}

const actions = {
  create(b) {
    const code = roomCode();
    const room = { code, players: new Map(), settings: cleanSettings(b.settings, DEFAULTS), phase: "lobby", center: null, reveals: [], events: [], touchedAt: Date.now() };
    const p = addPlayer(room, b.name);
    room.hostId = p.id;
    rooms.set(code, room);
    log(room, `${p.name} created the room.`);
    return { code, key: p.key };
  },
  join(b) {
    const room = rooms.get(String(b.code || "").toUpperCase().trim());
    if (!room) throw new Error("No room with that code.");
    if (room.phase !== "lobby") throw new Error("That game already started. Wait for the next round.");
    if (room.players.size >= 60) throw new Error("Room is full.");
    const p = addPlayer(room, b.name);
    log(room, `${p.name} joined.`);
    return { code: room.code, key: p.key };
  },
  state(b, room, me) { return view(room, me); },
  loc(b, room, me) {
    const pos = { lat: Number(b.lat), lng: Number(b.lng), acc: Math.round(Number(b.acc) || 0) };
    if (!validPos(pos)) throw new Error("Bad location.");
    me.pos = pos; me.posAt = Date.now();
    tick(room);
    return view(room, me);
  },
  settings(b, room, me) {
    hostOnly(room, me); lobbyOnly(room);
    room.settings = cleanSettings(b.settings, room.settings);
    if (b.center === null) room.center = null;
    else if (validPos(b.center)) room.center = { lat: Number(b.center.lat), lng: Number(b.center.lng) };
    return view(room, me);
  },
  start(b, room, me) {
    hostOnly(room, me); lobbyOnly(room);
    const all = [...room.players.values()];
    const s = room.settings;
    if (all.length < 2) throw new Error("You need at least 2 players.");
    if (s.hunters >= all.length) throw new Error(`With ${all.length} players you can have at most ${all.length - 1} hunter(s).`);
    const center = room.center || me.pos;
    if (!center) throw new Error("Set the zone center on the map, or allow location so it uses yours.");
    resetPlayers(room);
    const shuffled = all.slice();
    for (let i = shuffled.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    shuffled.slice(0, s.hunters).forEach((p) => (p.role = "hunter"));
    const now = Date.now();
    room.zone = { lat: center.lat, lng: center.lng, r: s.zoneKm * 1000 };
    room.nextZone = nextZone(room.zone, s);
    room.reveals = []; room.winner = null;
    room.startedAt = now;
    room.huntAt = now + s.headStartMin * MIN;
    room.endAt = room.huntAt + s.gameMin * MIN;
    room.phase = "hiding";
    log(room, `Game on. Hunters: ${shuffled.slice(0, s.hunters).map((p) => p.name).join(", ")}. Runners, go hide.`);
    tick(room, now);
    return view(room, me);
  },
  caught(b, room, me) {
    if (room.phase !== "hiding" && room.phase !== "hunting") throw new Error("No game running.");
    const target = [...room.players.values()].find((p) => p.id === b.target);
    if (!target || target.role !== "runner" || !target.alive) throw new Error("That runner is not in play.");
    const allowed = me.id === target.id || me.role === "hunter" || me.id === room.hostId;
    if (!allowed) throw new Error("Only hunters, the host, or the runner can do that.");
    target.alive = false; target.outReason = "caught"; target.outAt = Date.now(); target.caughtBy = me.role === "hunter" ? me.name : null;
    log(room, target.caughtBy ? `${target.caughtBy} caught ${target.name}.` : `${target.name} was caught.`);
    tick(room);
    return view(room, me);
  },
  end(b, room, me) {
    hostOnly(room, me);
    if (room.phase === "hiding" || room.phase === "hunting") finish(room, null, "The host ended the game.");
    return view(room, me);
  },
  lobby(b, room, me) {
    hostOnly(room, me);
    room.phase = "lobby"; room.zone = null; room.nextZone = null; room.reveals = [];
    resetPlayers(room);
    log(room, "Back to the lobby for a new round.");
    return view(room, me);
  },
  kick(b, room, me) {
    hostOnly(room, me);
    for (const [k, p] of room.players) if (p.id === b.target && p.id !== me.id) { room.players.delete(k); log(room, `${p.name} was removed.`); }
    return view(room, me);
  },
  leave(b, room, me) {
    room.players.delete(me.key);
    log(room, `${me.name} left.`);
    if (room.players.size === 0) rooms.delete(room.code);
    else if (me.id === room.hostId) { const next = room.players.values().next().value; room.hostId = next.id; log(room, `${next.name} is now the host.`); }
    if (room.phase === "hiding" || room.phase === "hunting") tick(room);
    return { ok: true };
  }
};
function hostOnly(room, me) { if (me.id !== room.hostId) throw new Error("Only the host can do that."); }
function lobbyOnly(room) { if (room.phase !== "lobby") throw new Error("Only in the lobby."); }

// ---------- HTTP ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) {
    const name = url.pathname.slice(5);
    if (req.method !== "POST" || !Object.hasOwn(actions, name)) return send(res, 404, { error: "Unknown action." });
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on("end", () => {
      try {
        const b = body ? JSON.parse(body) : {};
        if (name === "create" || name === "join") return send(res, 200, actions[name](b));
        const room = rooms.get(String(b.code || "").toUpperCase());
        const me = room && room.players.get(String(b.key || ""));
        if (!room || !me) return send(res, 410, { error: "You're not in that room anymore." });
        me.seenAt = room.touchedAt = Date.now();
        send(res, 200, actions[name](b, room, me));
      } catch (e) {
        send(res, 400, { error: e.message || "Something went wrong." });
      }
    });
    return;
  }
  // static files
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Hide and Seek running on http://localhost:${PORT}`));
