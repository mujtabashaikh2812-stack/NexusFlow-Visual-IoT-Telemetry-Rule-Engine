# NexusFlow - Database Setup (Day 1)

## What Day 1 delivers

A connection layer for MongoDB that does not crash when the database is missing or goes away:

- **Resilient connection manager** - `DatabaseConnection` connects to MongoDB with retries.
- **Exponential backoff** - the wait between attempts doubles each time, up to a cap.
- **Auto-reconnect** - if a live connection drops, the manager recovers by itself.
- **Zero-crash fallback** - if MongoDB cannot be reached, an in-memory store with the same calls takes over, so tests and CI run anywhere. The manager never calls `process.exit`.

## Files

| File | Purpose |
| --- | --- |
| `src/database/dbConnection.js` | Connection manager, backoff function, singleton `getDatabase()` |
| `src/database/inMemoryMock.js` | Dependency-free `InMemoryStore` that answers the same calls as a MongoDB collection |
| `src/database/smokeTest.js` | Manual proof against whatever database is available |
| `tests/dbConnection.test.js` | Automated tests (`node:test`) |
| `.env.example` | Environment variable template |
| `package.json` | Scripts and the two dependencies (`mongoose`, dev: `mongodb-memory-server`) |

## Modes

`getStats().mode` is one of:

- `mongodb` - connected, `collection(name)` returns the native driver collection.
- `reconnecting` - the connection dropped; recovery is in progress; `collection(name)` returns the in-memory handle so callers do not throw.
- `memory` - MongoDB was never reachable (or recovery gave up) and the fallback is allowed; `collection(name)` returns the in-memory handle.
- `disconnected` - not connected, closed, or gave up with fallback disabled; `collection(name)` throws a clear error.

## Backoff sequence

Delay = `baseDelayMs * 2^attempt`, capped at `maxDelayMs`.

Initial connect (defaults: base 100 ms, cap 2000 ms, 3 retries = 4 attempts):

| After failed attempt | 1 | 2 | 3 | 4 |
| --- | --- | --- | --- | --- |
| Wait before next | 100 ms | 200 ms | 400 ms | none, fallback |

Longer sequence for the same function: 100, 200, 400, 800, 1600, then 2000 (capped) from attempt 5 on.

Reconnect (defaults: base 100 ms, cap 5000 ms, 10 attempts): 100, 200, 400, 800, 1600, 3200, 5000, 5000, 5000, 5000 ms.

## Reconnect behaviour and its limits

1. The manager listens to the connection's `disconnected` and `error` events. On a drop it switches to `reconnecting` and schedules an attempt after the backoff delay.
2. Only one retry timer is ever pending, so a burst of drop events does not multiply retries.
3. Each attempt goes through the same connect function as the first connection. On success the mode returns to `mongodb`, `reconnects` goes up by one and one log line is written.
4. If every attempt fails and the fallback is allowed, the mode settles into `memory` with a log line. If the fallback is disabled, the last error is kept in `getStats().lastError`, retrying stops and the mode becomes `disconnected`.
5. `close()` cancels any pending retry.

Limits to be aware of:

- Data written to the in-memory handle while `reconnecting` or `memory` is **not** copied into MongoDB afterwards. It stays in the in-memory store and is lost when the process exits.
- Handles obtained from `collection()` before a drop (native collections) are not swapped automatically; call `collection(name)` again when you need a fresh one.
- Reconnect starts only after a connection was established at least once. A server that was never reachable ends in `memory` after the initial retries.
- An initial attempt can take up to `serverSelectionTimeoutMS` (5000 ms) when the server host does not answer at all, so a fully unreachable host takes longer than the delays above.
- Unique-index options are recorded by the in-memory store but not enforced (only `_id` is unique).

## How to run

```
npm install
npm test            # all tests
npm run test:db     # just the connection and in-memory tests
npm run smoke:db    # manual proof, prints "result : PASS"
```

Unreachable database (shows the retry lines and the clean fallback):

```
MONGODB_URI=mongodb://127.0.0.1:27099/nexusflow npm run smoke:db
```

One test starts a real `mongod` through `mongodb-memory-server` (the binary is downloaded on first use). If the binary cannot be downloaded or started, that single test is skipped with a visible message and the rest still run.

## Environment variables

Explicit options passed in code win over environment variables, which win over defaults.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/nexusflow` | Connection string |
| `NODE_ENV` | - | `production` makes `isProductionUri()` return true |
| `DB_MAX_RETRIES` | `3` | Retries after the first failed attempt |
| `DB_BASE_DELAY_MS` | `100` | First backoff delay for the initial connect |
| `DB_MAX_DELAY_MS` | `2000` | Backoff cap for the initial connect |
| `DB_RECONNECT_MAX_ATTEMPTS` | `10` | Reconnect attempts before giving up |

The code reads the real process environment (there is no dotenv dependency); to use a `.env` file run Node with `--env-file=.env` or export the variables in your shell. `.env` is never committed. Connection strings and passwords are never printed: `getStats()` and the log lines only show host, database name and a masked error message.

## Honest note

The in-memory store keeps everything in process memory and loses all data when the process exits. It is a development and CI aid so code can run without a database installed. It is not a database and must not be relied on to keep telemetry.
