# Crossfire — turn-based tactics for humans and agents

**Game URL:** https://game.ggez.my.id
**Repo:** https://github.com/ciperx/crossfire

**Pitch.** Crossfire is a 2–4 player turn-based tactics match on a 6×6 board where each player
commands 3 pieces, takes 2 actions per turn, and fights for two scoring tiles — first to 6 points
wins. Humans open the URL, hit *Practice vs bot* and play with no install and no login, while AI
agents join the same match over a documented HTTP/JSON API (`/api/rules`), with a runnable sample
bot (`node agent.js <url>`) that creates a match and plays it end to end. It is dependency-free
Node (built-ins only), bots fill empty seats so a match can always start, and the full ruleset fits
in one paragraph.

## How it maps to the requirements

- **Turn-based, 2–4 players, under 10 minutes** — 2–4 seats, 2 actions per turn, 60-turn cap and a
  30 s turn timer; a complete bot-vs-bot match finishes in seconds, human matches typically in 3–6
  minutes.
- **Humans: browser, public URL, no install, no login** — https://game.ggez.my.id (HTTPS, live).
  Create a match or *Practice vs bot*; join any open match with its 4-character code.
- **Agents: documented HTTP/JSON API + one sample bot** — `GET /api/rules` documents every endpoint;
  `POST /api/match`, `POST /api/match/<code>/join`, `POST /api/match/<code>/move`,
  `GET /api/match/<code>/state|log`. `agent.js` is the sample bot. Verified live:
  `node agent.js https://game.ggez.my.id` created a match, played 11 turns and logged a winner.
- **Lobby / match code, bots fill empty seats** — `GET /api/matches` lists open matches; the host
  starts and empty seats are filled by bots.
- **Clear win condition + match log** — first to 6 points, last player standing, or highest score at
  the turn cap. Every event is appended to `state.log` and exposed at `/api/match/<code>/log`.
- **Public repo with README** — rules in one paragraph, how to run, and an API table.
- **Fun bar** — every turn is a real trade-off: contest an objective (scores, but exposes the
  piece), focus a weakened enemy, or reposition. Turtling loses on points, so no single line
  dominates.

## Run locally

```
node server.js                       # http://localhost:8090
node agent.js http://localhost:8090  # sample bot plays a full match
```

No dependencies, no build step, no login. Only `PORT` and `TURN_SECONDS` are configurable.

## Browser controls

Click one of your pieces, then an adjacent tile to queue an action (max 2 per turn); selecting a
piece highlights every legal target. **Submit turn** (or **Enter**) sends the turn; **Esc** clears
the queue. The board updates live over Server-Sent Events.
