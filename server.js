#!/usr/bin/env node
"use strict";
/**
 * CROSSFIRE - a turn-based multiplayer strategy game playable by humans (browser)
 * and AI agents (HTTP/JSON). Zero npm dependencies: Node built-ins only.
 *
 *   node server.js                 # listens on $PORT (default 8090)
 *
 * Every request/response is JSON. See README.md for the agent API.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_FILE = path.join(__dirname, "matches.json");

const SIZE = 6;
const WALLS = ["2,2", "3,3"];
const OBJECTIVES = ["2,3", "3,2"];
const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const PIECES = 3;
const HP = 3;
const ACTIONS = 2;
const POINTS_TO_WIN = 6;
const TURN_CAP = 60;
const TURN_SECONDS = Number(process.env.TURN_SECONDS || 30);
const STARTS = [
  [[0, 0], [1, 0], [0, 1]],
  [[5, 5], [4, 5], [5, 4]],
  [[5, 0], [4, 0], [5, 1]],
  [[0, 5], [1, 5], [0, 4]],
];

const k = (x, y) => x + "," + y;
const nowISO = () => new Date().toISOString();
const uid = (n) => crypto.randomBytes(n || 8).toString("hex");
const inBounds = (x, y) => x >= 0 && x < SIZE && y >= 0 && y < SIZE;
const adjacent = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;

/** @type {Map<string, any>} */
const matches = new Map();
const streams = new Map(); // code -> Set<res>

/* ------------------------------------------------------------------ store */
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    for (const m of raw) matches.set(m.code, m);
    console.log("loaded", matches.size, "matches");
  } catch (e) {
    console.log("no store yet");
  }
}
let saveT = null;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify([...matches.values()]));
    } catch (e) {
      console.error("save failed", e.message);
    }
  }, 400);
}

/* ------------------------------------------------------------------ public view */
function view(m) {
  return {
    code: m.code,
    status: m.status,
    size: SIZE,
    walls: WALLS,
    objectives: OBJECTIVES,
    turn: m.turn,
    turnOf: m.turnOf,
    turnDeadline: m.turnDeadline,
    secondsLeft: m.turnDeadline
      ? Math.max(0, Math.round((new Date(m.turnDeadline) - Date.now()) / 1000))
      : null,
    rules: {
      actionsPerTurn: ACTIONS,
      hp: HP,
      pointsToWin: POINTS_TO_WIN,
      turnCap: TURN_CAP,
      scoring: "at the end of your turn you score 1 point per objective tile you occupy",
    },
    players: m.players.map((p) => ({
      seat: p.seat,
      name: p.name,
      bot: !!p.bot,
      alive: !!p.alive,
      points: p.points,
      hp: m.pieces.filter((q) => q.seat === p.seat).reduce((s, q) => s + q.hp, 0),
    })),
    pieces: m.pieces.map((p) => ({ id: p.id, seat: p.seat, x: p.x, y: p.y, hp: p.hp })),
    winner: m.winner,
    log: m.log.slice(-40),
  };
}

/* ------------------------------------------------------------------ engine */
function newMatch(name) {
  let code;
  do {
    code = crypto.randomBytes(2).toString("hex").toUpperCase();
  } while (matches.has(code));
  const m = {
    code,
    createdAt: nowISO(),
    status: "lobby",
    turn: 0,
    turnOf: 0,
    turnDeadline: null,
    players: [],
    pieces: [],
    winner: null,
    log: [],
  };
  matches.set(code, m);
  addPlayer(m, name || "host", false);
  return m;
}

function addPlayer(m, name, bot) {
  if (m.players.length >= MAX_PLAYERS) return null;
  const seat = m.players.length;
  const p = {
    seat,
    name: String(name || "player").slice(0, 24),
    bot: !!bot,
    alive: true,
    points: 0,
    token: bot ? "bot" : uid(16),
  };
  m.players.push(p);
  m.log.push({ at: nowISO(), type: "join", seat, name: p.name, bot: !!bot });
  return p;
}

function spawn(m) {
  m.pieces = [];
  m.players.forEach((p) => {
    STARTS[p.seat].forEach((c, i) => {
      m.pieces.push({ id: "p" + p.seat + "-" + i, seat: p.seat, x: c[0], y: c[1], hp: HP });
    });
  });
}

function playerAt(m, seat) {
  return m.players.find((p) => p.seat === seat);
}

function pieceAt(m, x, y) {
  return m.pieces.find((p) => p.x === x && p.y === y);
}

function startMatch(m, bySeat) {
  if (m.status !== "lobby") return { error: "match already started" };
  if (bySeat !== undefined && bySeat !== 0) return { error: "only the host can start" };
  let n = 0;
  while (m.players.length < MIN_PLAYERS) {
    addPlayer(m, "bot-" + (m.players.length + 1), true);
    n++;
  }
  m.players.forEach((p) => (p.alive = true));
  spawn(m);
  m.status = "active";
  m.turn = 1;
  m.turnOf = 0;
  arm(m);
  m.log.push({ at: nowISO(), type: "start", players: m.players.length, bots: n });
  save();
  return { ok: true, botsAdded: n };
}

function arm(m) {
  m.turnDeadline = new Date(Date.now() + TURN_SECONDS * 1000).toISOString();
}

function endTurn(m, reason) {
  const cur = playerAt(m, m.turnOf);
  // scoring: 1 point per objective tile held at the end of your turn
  if (cur && cur.alive) {
    let gained = 0;
    for (const o of OBJECTIVES) {
      const [x, y] = o.split(",").map(Number);
      const pc = pieceAt(m, x, y);
      if (pc && pc.seat === cur.seat) gained++;
    }
    if (gained) {
      cur.points += gained;
      m.log.push({ at: nowISO(), type: "score", seat: cur.seat, gained, total: cur.points });
    }
  }
  // eliminations
  for (const p of m.players) {
    if (p.alive && !m.pieces.some((q) => q.seat === p.seat)) {
      p.alive = false;
      m.log.push({ at: nowISO(), type: "eliminated", seat: p.seat, name: p.name });
    }
  }
  // win checks
  const alive = m.players.filter((p) => p.alive);
  const leader = [...m.players].sort((a, b) => b.points - a.points)[0];
  if (leader && leader.points >= POINTS_TO_WIN) {
    m.winner = leader.seat;
  } else if (alive.length <= 1) {
    m.winner = alive.length ? alive[0].seat : null;
  } else if (m.turn >= TURN_CAP) {
    const ranked = [...m.players].sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      const ha = m.pieces.filter((q) => q.seat === a.seat).reduce((s, q) => s + q.hp, 0);
      const hb = m.pieces.filter((q) => q.seat === b.seat).reduce((s, q) => s + q.hp, 0);
      return hb - ha;
    });
    m.winner = ranked[0].seat;
  }
  if (m.winner !== null) {
    m.status = "finished";
    m.turnDeadline = null;
    m.log.push({
      at: nowISO(),
      type: "finished",
      winner: m.winner,
      name: (playerAt(m, m.winner) || {}).name,
      reason: reason || "win condition",
    });
    save();
    return;
  }
  // next living seat
  let next = m.turnOf;
  for (let i = 0; i < MAX_PLAYERS; i++) {
    next = (next + 1) % MAX_PLAYERS;
    const p = playerAt(m, next);
    if (p && p.alive) break;
  }
  m.turnOf = next;
  m.turn++;
  m.turnDeadline = new Date(Date.now() + TURN_SECONDS * 1000).toISOString();
  save();
  // A bot does not need to wait for the turn timer: play its turn on the next tick so a
  // bot-vs-bot match finishes in seconds instead of 30 s per turn.
  const nxt = playerAt(m, next);
  if (nxt && nxt.bot && m.status === "active") {
    clearTimeout(m._botT);
    m._botT = setTimeout(() => {
      if (m.status === "active" && m.turnOf === next) botTurn(m);
    }, 250);
  }
}

function applyActions(m, seat, actions) {
  const p = playerAt(m, seat);
  if (!p) return { error: "unknown seat" };
  if (m.status !== "active") return { error: "match is not active" };
  if (m.turnOf !== seat) return { error: "not your turn (turn is " + m.turnOf + ")" };
  if (!Array.isArray(actions)) return { error: "actions must be an array" };
  if (actions.length > ACTIONS) return { error: "at most " + ACTIONS + " actions per turn" };

  const done = [];
  for (const a of actions) {
    if (!a || typeof a !== "object") return { error: "bad action" };
    const pc = m.pieces.find((q) => q.id === a.pieceId);
    if (!pc || pc.seat !== seat) return { error: "piece " + a.pieceId + " is not yours" };
    const to = Array.isArray(a.to) ? a.to.map(Number) : null;
    if (!to || to.length !== 2 || !inBounds(to[0], to[1]))
      return { error: "bad destination for " + a.pieceId };
    if (!adjacent([pc.x, pc.y], to))
      return { error: a.pieceId + " can only act on an orthogonally adjacent tile" };
    if (WALLS.includes(k(to[0], to[1]))) return { error: "tile " + k(to[0], to[1]) + " is a wall" };

    const target = pieceAt(m, to[0], to[1]);
    if (a.type === "move") {
      if (target) return { error: "tile " + k(to[0], to[1]) + " is occupied" };
      pc.x = to[0];
      pc.y = to[1];
      done.push({ type: "move", pieceId: pc.id, to });
    } else if (a.type === "attack") {
      if (!target) return { error: "no piece to attack at " + k(to[0], to[1]) };
      if (target.seat === seat) return { error: "cannot attack your own piece" };
      target.hp -= 1;
      done.push({ type: "attack", pieceId: pc.id, target: target.id, targetHp: target.hp, to });
      if (target.hp <= 0) {
        m.pieces = m.pieces.filter((q) => q.id !== target.id);
        done.push({ type: "killed", pieceId: target.id, seat: target.seat });
      }
    } else {
      return { error: "type must be 'move' or 'attack'" };
    }
  }
  m.log.push({ at: nowISO(), type: "turn", seat, actions: done });
  endTurn(m, "turn completed");
  broadcast(m);
  return { ok: true, state: view(m) };
}

/* ------------------------------------------------------------------ server bot */
function botTurn(m) {
  const seat = m.turnOf;
  const mine = m.pieces.filter((p) => p.seat === seat);
  const foes = m.pieces.filter((p) => p.seat !== seat);
  if (!mine.length) return applyActions(m, seat, []);
  const acts = [];
  const used = new Set();

  const nearestObj = (from) => {
    let best = null;
    let bd = 1e9;
    for (const o of OBJECTIVES) {
      const [x, y] = o.split(",").map(Number);
      if (pieceAt(m, x, y) && pieceAt(m, x, y).seat === seat) continue;
      const d = Math.abs(from[0] - x) + Math.abs(from[1] - y);
      if (d < bd) {
        bd = d;
        best = [x, y];
      }
    }
    return best;
  };

  for (let i = 0; i < ACTIONS; i++) {
    // 1) attack the weakest adjacent enemy
    let best = null;
    for (const pc of mine) {
      if (used.has(pc.id)) continue;
      for (const f of foes) {
        if (Math.abs(pc.x - f.x) + Math.abs(pc.y - f.y) === 1) {
          if (!best || f.hp < best.f.hp) best = { pc, f, to: [f.x, f.y] };
        }
      }
    }
    if (best) {
      used.add(best.pc.id);
      acts.push({ pieceId: best.pc.id, type: "attack", to: best.to });
      const t = m.pieces.find((q) => q.x === best.to[0] && q.y === best.to[1]);
      if (t) t.hp -= 1;
      if (t && t.hp <= 0) m.pieces = m.pieces.filter((q) => q.id !== t.id);
      continue;
    }
    // 2) walk toward an objective, else toward the nearest enemy
    let moved = false;
    for (const pc of mine) {
      if (used.has(pc.id)) continue;
      const goal = nearestObj([pc.x, pc.y]) || (foes[0] ? [foes[0].x, foes[0].y] : null);
      if (!goal) break;
      const opts = [[pc.x + 1, pc.y], [pc.x - 1, pc.y], [pc.x, pc.y + 1], [pc.x, pc.y - 1]]
        .filter(([x, y]) => inBounds(x, y) && !WALLS.includes(k(x, y)) && !pieceAt(m, x, y));
      if (!opts.length) continue;
      opts.sort(
        (a, b) =>
          Math.abs(a[0] - goal[0]) + Math.abs(a[1] - goal[1]) -
          (Math.abs(b[0] - goal[0]) + Math.abs(b[1] - goal[1]))
      );
      const to = opts[0];
      used.add(pc.id);
      acts.push({ pieceId: pc.id, type: "move", to });
      pc.x = to[0];
      pc.y = to[1];
      moved = true;
      break;
    }
    if (!moved) break;
  }
  m.log.push({ at: nowISO(), type: "turn", seat, bot: true, actions: acts });
  endTurn(m, "bot turn");
  broadcast(m);
  return { ok: true };
}

/* ------------------------------------------------------------------ sse */
function broadcast(m) {
  const set = streams.get(m.code);
  if (!set) return;
  const payload = "data: " + JSON.stringify(view(m)) + "\n\n";
  for (const res of set) {
    try {
      res.write(payload);
    } catch (e) {
      set.delete(res);
    }
  }
}

/* ------------------------------------------------------------------ http */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function body(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
      if (b.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch (e) {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const parts = u.pathname.split("/").filter(Boolean);
  if (req.method === "OPTIONS") return json(res, 204, {});

  // static client
  if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
    const f = path.join(__dirname, "public", "index.html");
    fs.readFile(f, (e, d) => {
      if (e) return json(res, 500, { error: "client missing" });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(d);
    });
    return;
  }

  if (u.pathname === "/api/health") return json(res, 200, { ok: true, matches: matches.size });

  if (u.pathname === "/api/rules")
    return json(res, 200, {
      name: "Crossfire",
      board: SIZE + "x" + SIZE,
      players: MIN_PLAYERS + "-" + MAX_PLAYERS,
      piecesPerPlayer: PIECES,
      hp: HP,
      actionsPerTurn: ACTIONS,
      pointsToWin: POINTS_TO_WIN,
      turnCap: TURN_CAP,
      turnSeconds: TURN_SECONDS,
      walls: WALLS,
      objectives: OBJECTIVES,
      scoring: "1 point per objective tile held at the end of your turn",
      moves: "orthogonally adjacent: {type:'move',to:[x,y]} or {type:'attack',to:[x,y]}",
      api: [
        "POST /api/match {name}",
        "POST /api/match/:code/join {name}",
        "POST /api/match/:code/start {token}",
        "GET  /api/match/:code/state",
        "POST /api/match/:code/move {token,actions:[...]}",
        "GET  /api/match/:code/log",
        "GET  /api/match/:code/events  (SSE)",
        "GET  /api/matches",
      ],
    });

  // create
  if (req.method === "POST" && u.pathname === "/api/match") {
    const b = await body(req);
    const m = newMatch(b.name);
    save();
    const p = m.players[0];
    return json(res, 201, { code: m.code, seat: p.seat, token: p.token, state: view(m) });
  }

  if (req.method === "GET" && u.pathname === "/api/matches")
    return json(res, 200, {
      matches: [...matches.values()]
        .filter((m) => m.status === "lobby")
        .map((m) => ({ code: m.code, players: m.players.length, max: MAX_PLAYERS })),
    });

  if (parts[0] === "api" && parts[1] === "match" && parts[2]) {
    const m = matches.get(String(parts[2]).toUpperCase());
    if (!m) return json(res, 404, { error: "no such match" });
    const tail = parts[3];

    if (tail === "state") return json(res, 200, view(m));

    if (tail === "log") return json(res, 200, { code: m.code, log: m.log });

    if (tail === "join" && req.method === "POST") {
      const b = await body(req);
      if (m.status !== "lobby") return json(res, 200, { spectator: true, state: view(m) });
      const p = addPlayer(m, b.name, false);
      if (!p) return json(res, 200, { spectator: true, state: view(m) });
      save();
      broadcast(m);
      return json(res, 200, { code: m.code, seat: p.seat, token: p.token, state: view(m) });
    }

    if (tail === "start" && req.method === "POST") {
      const b = await body(req);
      const p = m.players.find((q) => q.token === b.token);
      const r = startMatch(m, p ? p.seat : undefined);
      if (r.error) return json(res, 400, r);
      broadcast(m);
      return json(res, 200, { ok: true, state: view(m) });
    }

    if (tail === "move" && req.method === "POST") {
      const b = await body(req);
      const p = m.players.find((q) => q.token === b.token);
      if (!p) return json(res, 403, { error: "bad token" });
      const r = applyActions(m, p.seat, b.actions);
      if (r.error) return json(res, 400, r);
      return json(res, 200, { ok: true, state: r.state });
    }

    if (tail === "events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.write("data: " + JSON.stringify(view(m)) + "\n\n");
      if (!streams.has(m.code)) streams.set(m.code, new Set());
      streams.get(m.code).add(res);
      req.on("close", () => {
        const s = streams.get(m.code);
        if (s) s.delete(res);
      });
      return;
    }
  }

  json(res, 404, { error: "not found" });
});

/* ------------------------------------------------------------------ clock */
setInterval(() => {
  for (const m of matches.values()) {
    if (m.status !== "active" || !m.turnDeadline) continue;
    if (new Date(m.turnDeadline) > new Date()) continue;
    const cur = playerAt(m, m.turnOf);
    if (cur && cur.bot) {
      botTurn(m);
    } else {
      m.log.push({ at: nowISO(), type: "timeout", seat: m.turnOf });
      endTurn(m, "turn timer expired");
      broadcast(m);
    }
  }
}, 1000);

load();
server.listen(PORT, HOST, () => console.log("Crossfire on http://" + HOST + ":" + PORT));
