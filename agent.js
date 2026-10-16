#!/usr/bin/env node
"use strict";
/**
 * Crossfire sample bot - plays a match over the HTTP/JSON API. No dependencies.
 *
 *   node agent.js <baseUrl> [matchCode]
 *
 * With no code it creates a match, starts it, and plays. With a code it joins and plays.
 * Strategy is deliberately simple: attack the weakest adjacent enemy, otherwise walk toward the
 * nearest objective tile. It is meant as a readable starting point, not a strong opponent.
 */
const BASE = (process.argv[2] || process.env.BASE || "http://localhost:8090").replace(/\/$/, "");
const CODE = process.argv[3] || null;
const NAME = process.env.AGENT_NAME || "sample-bot";
const SIZE = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, body) {
  const r = await fetch(BASE + path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || "HTTP " + r.status);
  return j;
}

function adjacent(p) {
  return [[p.x + 1, p.y], [p.x - 1, p.y], [p.x, p.y + 1], [p.x, p.y - 1]];
}
const occupied = (s, x, y) => s.pieces.find((q) => q.x === x && q.y === y);
const wall = (s, x, y) => s.walls.includes(x + "," + y);
const inb = (x, y) => x >= 0 && y >= 0 && x < SIZE && y < SIZE;

function plan(s, seat) {
  const mine = s.pieces.filter((p) => p.seat === seat);
  const foes = s.pieces.filter((p) => p.seat !== seat);
  const acts = [];
  const used = new Set();       // pieces that already acted
  const claimed = new Set();    // destinations already taken by an earlier action in this batch

  const nearestObjective = (from) => {
    let best = null;
    let bd = 1e9;
    for (const o of s.objectives) {
      const [x, y] = o.split(",").map(Number);
      const here = occupied(s, x, y);
      if (here && here.seat === seat) continue;
      if (claimed.has(x + "," + y)) continue;
      const d = Math.abs(from[0] - x) + Math.abs(from[1] - y);
      if (d < bd) { bd = d; best = [x, y]; }
    }
    return best;
  };

  for (let i = 0; i < s.rules.actionsPerTurn; i++) {
    // 1. attack the weakest adjacent enemy
    let best = null;
    for (const pc of mine) {
      if (used.has(pc.id)) continue;
      for (const f of foes) {
        if (Math.abs(pc.x - f.x) + Math.abs(pc.y - f.y) === 1 && (!best || f.hp < best.f.hp)) {
          best = { pc, f, to: [f.x, f.y] };
        }
      }
    }
    if (best) {
      used.add(best.pc.id);
      acts.push({ pieceId: best.pc.id, type: "attack", to: best.to });
      continue;
    }
    // 2. otherwise step toward the nearest objective (or the nearest enemy)
    let stepped = false;
    for (const pc of mine) {
      if (used.has(pc.id)) continue;
      const goal = nearestObjective([pc.x, pc.y]) || (foes[0] ? [foes[0].x, foes[0].y] : null);
      if (!goal) break;
      const opts = adjacent(pc)
        .filter(([x, y]) => inb(x, y) && !wall(s, x, y) && !occupied(s, x, y)
                            && !claimed.has(x + "," + y))
        .sort((a, b) =>
          Math.abs(a[0] - goal[0]) + Math.abs(a[1] - goal[1]) -
          (Math.abs(b[0] - goal[0]) + Math.abs(b[1] - goal[1])));
      if (!opts.length) continue;
      used.add(pc.id);
      claimed.add(opts[0][0] + "," + opts[0][1]);
      acts.push({ pieceId: pc.id, type: "move", to: opts[0] });
      stepped = true;
      break;
    }
    if (!stepped) break;
  }
  return acts;
}

(async () => {
  let code = CODE;
  let token;
  let seat;

  if (code) {
    const j = await call(`/api/match/${code}/join`, { name: NAME });
    if (j.spectator) throw new Error("match already running");
    token = j.token;
    seat = j.seat;
    console.log("joined", code, "as seat", seat);
  } else {
    const j = await call("/api/match", { name: NAME });
    code = j.code;
    token = j.token;
    seat = j.seat;
    console.log("created match", code, "as seat", seat);
    const st = await call(`/api/match/${code}/start`, { token });
    console.log("started with", st.state.players.length, "players");
  }

  for (let n = 0; n < 400; n++) {
    const s = await call(`/api/match/${code}/state`);
    if (s.status === "finished") {
      const w = s.players.find((p) => p.seat === s.winner);
      console.log("finished - winner:", w ? w.name + " (seat " + w.seat + ")" : "none");
      return;
    }
    if (s.status === "active" && s.turnOf === seat) {
      const acts = plan(s, seat);
      const r = await call(`/api/match/${code}/move`, { token, actions: acts });
      console.log("turn", s.turn, "played", JSON.stringify(acts));
      if (r.state.status === "finished") {
        const w = r.state.players.find((p) => p.seat === r.state.winner);
        console.log("finished - winner:", w ? w.name + " (seat " + w.seat + ")" : "none");
        return;
      }
    }
    await sleep(700);
  }
  console.log("stopped after the turn cap");
})().catch((e) => {
  console.error("agent error:", e.message);
  process.exit(1);
});
