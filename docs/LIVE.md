# Live updates (`/api/v1/live`)

Replaces Supabase Realtime: the app's 12 `sb.channel(...)` subscriptions (list and mapping:
[TABLE_QUERIES.md](TABLE_QUERIES.md#live-sbchannel)). Built and tested, **not switched on**: the app still uses
Realtime until the frontend switch.

## How it works

- **Row changes.** Migration `0004_backend_live_notify.sql` (pending approval) adds an AFTER trigger to the 22 tables
  the app watches. Each committed change sends `NOTIFY backend_live` with the table, the kind of change, the key and
  the row's id columns - no other data. The backend LISTENs on one dedicated connection (`LIVE_DATABASE_URL`, session
  mode, port 5432 - the transaction pooler drops notifications). For every connected subscription that matches, it
  re-reads the row **in that subscriber's own session**, so row-level security and column grants decide who gets it -
  the check Realtime made. A rolled-back change sends nothing.
- **Rooms** (typing and presence in a conversation, call signalling) are kept in the backend's memory. Only the
  conversation's buyer and shop owner may join `conversation:<id>`, only the caller and callee `call:<id>` (finding
  S14), and every broadcast carries the real sender in `from`.
- One process is enough today. With more than one, rooms need sharing between them (PostgreSQL `NOTIFY` again, no
  extra service); row changes already work with any number, since each process LISTENs itself.
- Runs on the long-running server (`npm start`), not on Vercel functions (they cannot hold a WebSocket).

## Protocol

JSON text messages over `wss://<backend>/api/v1/live`. Only the app's origins may connect.

| Client sends | Meaning |
|---|---|
| `{"type":"auth","token":"<access token>"}` | Sign in (first message; again after a token refresh). `null` signs out. The backend session cookie also works. |
| `{"type":"subscribe","id":"orders","changes":[{"event":"*","table":"orders","filter":"buyer_id=eq.<uuid>"}]}` | Row changes. `event`: `INSERT`, `UPDATE`, `DELETE` or `*`; `filter`: `column=eq.value` or `column=in.(a,b)`. Up to 10 per subscription, 50 subscriptions. |
| `{"type":"subscribe","id":"chat","room":"conversation:<uuid>","presence":true,"changes":[...]}` | Join a room (and optionally watch changes in the same subscription). `"self":true` also echoes your own broadcasts. |
| `{"type":"broadcast","id":"chat","event":"typing","payload":{...}}` | To everyone else in the room. |
| `{"type":"track","id":"chat","state":{...}}` / `{"type":"untrack","id":"chat"}` | Presence (state up to 2 KB; the key is your user id). |
| `{"type":"unsubscribe","id":"chat"}` / `{"type":"ping"}` | |

| Server sends | Meaning |
|---|---|
| `{"type":"hello","userId":...}`, `{"type":"authenticated","userId":...}`, `{"type":"auth_expired"}` | Connection state. At the token's expiry the connection continues signed out. |
| `{"type":"subscribed","id":...}` / `{"type":"error","ref":...,"message":...}` / `{"type":"closed","id":...,"reason":...}` | |
| `{"type":"change","id":"orders","table":"orders","schema":"public","eventType":"UPDATE","commit_timestamp":...,"new":{...},"old":{"id":...}}` | Same shape as Realtime's payload. `old` holds only the key (as Realtime without full replica identity); DELETE has `new: {}`. |
| `{"type":"broadcast","id":"chat","event":"typing","payload":{...},"from":"<sender's user id>"}` | |
| `{"type":"presence","id":"chat","event":"join"|"leave","key":...,"state":{...}}` then `{"event":"sync","state":{"<user id>":[{...}]}}` | |

## Differences from Realtime (on purpose)

- Rooms are restricted to their two people and the sender is verified (S14).
- `package_comments` changes arrive (B15).
- A DELETE is sent only to subscriptions whose filter matches the deleted row's id columns (Realtime sent deletes to
  every subscriber of the table, ignoring the filter).
- Like Realtime, nothing is replayed after a reconnect: the app refetches when it comes back (it already does).

Tests: `tests/parity/live.parity.test.ts` (every channel's subscription against the same row read as the same user)
and `tests/v1/live-socket.test.ts` (a real WebSocket).
