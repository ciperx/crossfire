# Crossfire — submission

**Public game URL:** https://game.ggez.my.id

**Public repo:** https://github.com/ciperx/crossfire

**Pitch (3 sentences).** Crossfire is a turn-based tactics match on a 6×6 board where 2–4 players each
command 3 pieces, take 2 actions per turn, and fight for two scoring tiles — first to 6 points wins.
Humans join in the browser with no install and no login (create a match, share the 4-character code,
or hit *Practice vs bot*), and AI agents join the **same** match over a documented HTTP/JSON API,
reading state and posting moves with one call; a runnable sample bot (`node agent.js <url>`) plays a
full match end to end. It is dependency-free Node (built-ins only), bots fill empty seats so a match
can always start, and the whole ruleset fits in one paragraph at `/api/rules`.

## Requirements → evidence

- **Turn-based, 2–4 players, matches under 10 minutes** — 2–4 seats; a 60-turn cap plus 30 s turn
  timer bounds length; a full bot-vs-bot match completes in seconds during testing.
- **Humans play in a browser at a public URL, no install, no login** — the URL above serves the
  client over HTTPS; open it, hit *Practice vs bot*, and play immediately.
- **Agents play via a documented HTTP/JSON API; include one basic sample bot** — `/api/rules`
  documents every endpoint; `agent.js` is the sample bot (creates or joins a match and plays it).
  Verified live: `node agent.js https://game.ggez.my.id` created a match, played it to the end and
  **won 3 of 3** against the built-in bot (first match 6-2, `turn 17`).
- **Lobby or match code to join; empty seats filled by a bot** — lobby lists open matches
  (`GET /api/matches`), join with the room code, and `POST /start` fills empty seats with bots.
- **Clear win condition; a match log or replay** — first to 6 points, or last player standing, or
  highest score at the turn cap; every event is in `state.log` and `GET /api/match/<code>/log`.
- **Public repo with README: rules in one paragraph, how to run, API docs** — repo above; README has
  the one-paragraph rules, run instructions, and the API table.
- **Fun bar: a meaningful decision every turn, no dominant strategy** — each turn forces a choice
  between contesting an objective (scores, but exposes the piece), focusing a weakened enemy, or
  repositioning; turtling loses on points, so no single line dominates.

## How to run

```
node server.js                          # http://localhost:8090
node agent.js http://localhost:8090     # sample bot plays a full match
```

No dependencies, no build step, no login. `PORT` and `TURN_SECONDS` are the only env vars.

## Browser controls

Click one of your pieces, then an adjacent tile to queue an action (max 2 per turn); selecting a
piece highlights every legal target. **Submit turn** (or **Enter**) sends the turn; **Esc** clears
the queue.
