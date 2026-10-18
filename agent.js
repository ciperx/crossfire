#!/usr/bin/env node
"use strict";
/**
 * Crossfire sample bot - plays a match over the HTTP/JSON API. No dependencies.
 *
 *   node agent.js <baseUrl> [matchCode]
 *
 * With no code it creates a match, starts it, and plays. With a code it joins and plays.
 *
 * Strategy (deliberately simple, but it actually plays to win):
 *   1. Kill shot   - attack an adjacent enemy that has 1 hp left.
 *   2. Claim       - step onto an empty objective tile.
 *   3. Contest     - attack an enemy standing on an objective.
 *   4. Advance     - BFS one step along the shortest path to an unheld objective.
 *   5. Fight       - attack the weakest adjacent enemy.
 *   6. Hold        - otherwise pass, because a piece standing on an objective scores
 *                    1 point at the end of the turn. Leaving a scoring tile is a loss.
 *
 * Scoring is "1 point per objective tile you occupy at the end of your turn", so the bot
 * never walks off a tile it already holds. That is the single biggest difference between
 * this bot and a naive "walk toward the nearest objective" loop, which oscillates.
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

const k = (x, y) => x + "," + y;
const manhattan = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
const adjacentTo = (a, b) => manhattan(a, b) === 1;

function neighbours(x, y) {
  return [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
}

function inBounds(x, y) {
  return x >= 0 && y >= 0 && x < SIZE && y < SIZE;
}

/**
 * Breadth-first search for the first step from `start` to the nearest tile in `goals`.
 * Avoids walls and occupied tiles. Returns [x,y] or null.
 */
function firstStep(start, goals, walls, occupied) {
  const startKey = k(start[0], start[1]);
  const prev = new Map([[startKey, null]]);
  const queue = [[start[0], start[1]]];

  while (queue.length) {
    const [x, y] = queue.shift();
    const here = k(x, y);

    if (goals.some(([gx, gy]) => gx === x && gy === y)) {
      // Walk the parent chain back to the start; the last node pushed is the first step.
      let cur = here;
      let step = null;
      while (prev.get(cur)) {
        step = cur.split(",").map(Number);
        cur = prev.get(cur);
      }
      return step;
    }

    for (const [nx, ny] of neighbours(x, y)) {
      const nk = k(nx, ny);
      if (!inBounds(nx, ny) || walls.has(nk) || occupied.has(nk) || prev.has(nk)) continue;
      prev.set(nk, here);
      queue.push([nx, ny]);
    }
  }
  return null;
}

function plan(s, seat) {
  const actionsPerTurn = s.rules.actionsPerTurn || 2;
  const objectives = s.objectives.map((o) => o.split(",").map(Number));
  const walls = new Set(s.walls);
  // Work on a copy so two actions in the same turn cannot collide.
  const pieces = s.pieces.map((p) => ({ ...p }));
  const acts = [];

  const mine = () => pieces.filter((p) => p.seat === seat);
  const foes = () => pieces.filter((p) => p.seat !== seat);
  const pieceAt = (x, y) => pieces.find((p) => p.x === x && p.y === y);
  const heldByMe = (p) => objectives.some(([x, y]) => x === p.x && y === p.y);

  const apply = (action) => {
    const pc = pieces.find((p) => p.id === action.pieceId);
    if (action.type === "move") {
      pc.x = action.to[0];
      pc.y = action.to[1];
    } else {
      const target = pieceAt(action.to[0], action.to[1]);
      if (target) target.hp -= 1;
      if (target && target.hp <= 0) pieces.splice(pieces.indexOf(target), 1);
    }
    acts.push({ pieceId: action.pieceId, type: action.type, to: action.to });
  };

  for (let slot = 0; slot < actionsPerTurn; slot++) {
    const myPieces = mine();
    if (!myPieces.length) break;
    const enemyPieces = foes();
    let choice = null;

    // 1. Kill shot: remove an adjacent enemy that is one hit from dying.
    for (const pc of myPieces) {
      for (const f of enemyPieces) {
        if (adjacentTo([pc.x, pc.y], [f.x, f.y]) && f.hp <= 1) {
          choice = { pieceId: pc.id, type: "attack", to: [f.x, f.y] };
          break;
        }
      }
      if (choice) break;
    }

    // 2. Claim an empty objective tile.
    if (!choice) {
      let best = null;
      for (const pc of myPieces) {
        if (heldByMe(pc)) continue; // never leave a scoring tile
        for (const [ox, oy] of objectives) {
          if (pieceAt(ox, oy)) continue;
          if (adjacentTo([pc.x, pc.y], [ox, oy])) {
            const d = manhattan([pc.x, pc.y], [ox, oy]);
            if (!best || d < best.d) best = { pieceId: pc.id, type: "move", to: [ox, oy], d };
          }
        }
      }
      if (best) choice = { pieceId: best.pieceId, type: best.type, to: best.to };
    }

    // 3. Contest: an enemy is sitting on an objective we want.
    if (!choice) {
      for (const pc of myPieces) {
        for (const f of enemyPieces) {
          const onObjective = objectives.some(([x, y]) => x === f.x && y === f.y);
          if (onObjective && adjacentTo([pc.x, pc.y], [f.x, f.y])) {
            choice = { pieceId: pc.id, type: "attack", to: [f.x, f.y] };
            break;
          }
        }
        if (choice) break;
      }
    }

    // 4. Advance one BFS step toward an objective we do not hold.
    if (!choice) {
      const occupied = new Set(pieces.map((p) => k(p.x, p.y)));
      const unheld = objectives.filter(([x, y]) => {
        const holder = pieceAt(x, y);
        return !holder || holder.seat !== seat;
      });
      if (unheld.length) {
        let best = null;
        for (const pc of myPieces) {
          if (heldByMe(pc)) continue;
          const step = firstStep([pc.x, pc.y], unheld, walls, occupied);
          if (!step) continue;
          const d = manhattan([pc.x, pc.y], step);
          if (!best || d < best.d) best = { pieceId: pc.id, type: "move", to: step, d };
        }
        if (best) choice = { pieceId: best.pieceId, type: best.type, to: best.to };
      }
    }

    // 5. Fight: hit the weakest adjacent enemy.
    if (!choice) {
      let best = null;
      for (const pc of myPieces) {
        for (const f of enemyPieces) {
          if (adjacentTo([pc.x, pc.y], [f.x, f.y]) && (!best || f.hp < best.hp)) {
            best = { pieceId: pc.id, type: "attack", to: [f.x, f.y], hp: f.hp };
          }
        }
      }
      if (best) choice = { pieceId: best.pieceId, type: best.type, to: best.to };
    }

    // 6. Otherwise pass: holding a scoring tile is worth more than a pointless move.
    if (!choice) break;
    apply(choice);
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

  for (let n = 0; n < 600; n++) {
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
    await sleep(600);
  }
  console.log("stopped after the turn cap");
})().catch((e) => {
  console.error("agent error:", e.message);
  process.exit(1);
});
