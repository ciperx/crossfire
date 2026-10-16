# Crossfire

A small, polished, turn-based multiplayer tactics game that **humans play in the browser** and
**AI agents play over a plain HTTP/JSON API**, in the same match. No install, no login, no
dependencies — Node built-ins only.

```
node server.js          # http://localhost:8090
node agent.js http://localhost:8090        # sample bot: creates a match and plays it
```

## The rules, in one paragraph

A 6×6 board holds **2–4 players**, each with **3 pieces** of **3 HP**. On your turn you take up to
**2 actions**; each action is a **move** to an orthogonally adjacent empty tile, or an **attack** on
an orthogonally adjacent enemy piece, which removes 1 HP and destroys the piece at 0. Two tiles are
**objectives** (marked with a dashed ring); at the end of your turn you **score 1 point for each
objective you occupy**. Two tiles are **walls** and block movement. The first player to **6 points**
wins; if a player loses all pieces they are eliminated; if the turn cap (60) is reached, the highest
score (then total HP) wins. Empty seats can be filled by bots, so a match can always start.

## Play in a browser

Open the URL, type a name, then **Create match** or **Practice vs bot** (creates, starts and fills
empty seats with bots immediately). Share the 4-character room code for others to **Join**. The board
updates live over Server-Sent Events.

## Play as an agent (HTTP/JSON)

All endpoints are JSON. Base URL is whatever host serves this app.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/rules` | — | the full rule set and the endpoint list |
| GET | `/api/health` | — | `{ok, matches}` |
| POST | `/api/match` | `{name}` | `{code, seat, token, state}` |
| POST | `/api/match/:code/join` | `{name}` | `{code, seat, token, state}` (or `{spectator:true}`) |
| POST | `/api/match/:code/start` | `{token}` | `{ok, state}` (host only; fills empty seats with bots) |
| GET | `/api/match/:code/state` | — | the full public state |
| POST | `/api/match/:code/move` | `{token, actions:[…]}` | `{ok, state}` |
| GET | `/api/match/:code/log` | — | the event log |
| GET | `/api/match/:code/events` | — | Server-Sent Events stream of state |
| GET | `/api/matches` | — | open lobby matches |

An action is `{"pieceId":"p0-0","type":"move","to":[1,0]}` or
`{"pieceId":"p0-0","type":"attack","to":[1,1]}`. At most 2 actions per turn. `state.pieces` lists
every piece with `id`, `seat`, `x`, `y`, `hp`; `state.objectives` and `state.walls` are `"x,y"` strings.

Minimal agent loop:

```js
const base = "http://localhost:8090";
const { code, token, seat } = await (await fetch(base + "/api/match",
  {method:"POST", headers:{"Content-Type":"application/json"},
   body: JSON.stringify({name:"my-agent"})})).json();
await fetch(`${base}/api/match/${code}/start`, {method:"POST",
  headers:{"Content-Type":"application/json"}, body: JSON.stringify({token})});

while (true) {
  const s = await (await fetch(`${base}/api/match/${code}/state`)).json();
  if (s.status === "finished") break;
  if (s.turnOf === seat) {
    const actions = [ /* your plan, up to 2 */ ];
    await fetch(`${base}/api/match/${code}/move`, {method:"POST",
      headers:{"Content-Type":"application/json"}, body: JSON.stringify({token, actions})});
  }
  await new Promise(r => setTimeout(r, 700));
}
```

A complete, runnable example is `agent.js` (creates or joins a match and plays to the end).

## Design notes

- **Fun bar** — every turn has a real choice: contest an objective, focus a weakened piece, or
  reposition. Objectives force contact; 3 HP and 3 pieces make each attack meaningful without being
  lethal; the 60-turn cap keeps matches under ten minutes.
- **No dominant strategy** — holding an objective scores, but pieces on objectives are exposed to
  attacks; turtling loses on points.
- **State** — matches live in memory and are mirrored to `matches.json`, so a restart keeps lobbies.
- **Turn timer** — 30 s per turn by default (`TURN_SECONDS`); a timeout passes the turn, and a bot's
  turn is played automatically.
