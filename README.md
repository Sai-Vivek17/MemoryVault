# MemoryVault

[![CI](https://github.com/Sai-Vivek17/MemoryVault/actions/workflows/ci.yml/badge.svg)](https://github.com/Sai-Vivek17/MemoryVault/actions/workflows/ci.yml)

MemoryVault is a small, durable in-memory key-value database written in Node.js.
It accepts commands over a raw TCP socket, persists mutations to a synchronized
append-only file (AOF), and preserves key expiration times across restarts.

It is intentionally dependency-free and uses a documented custom protocol. It
is inspired by Redis concepts, but it is **not wire-compatible with Redis**.

## Features

- O(1) in-memory key lookup using `Map`
- Raw TCP server with fragmented and pipelined command handling
- Synchronized write-ahead log before in-memory mutation acknowledgement
- TTL expiration that survives restarts and offline time
- Backward-compatible loading of the original MemoryVault AOF format
- Optional password authentication with timing-safe comparison
- Configurable host, port, data path, and maximum command size
- Graceful shutdown on `SIGINT` and `SIGTERM`
- Automated unit and integration tests on Linux and Windows

## Requirements

- Node.js 18 or newer
- A TCP client such as `nc`, `ncat`, or `telnet`

## Quick start

```bash
git clone https://github.com/Sai-Vivek17/MemoryVault.git
cd MemoryVault
npm install
npm test
npm start
```

MemoryVault listens on `127.0.0.1:6379` by default. In another terminal:

```bash
nc 127.0.0.1 6379
```

Then enter commands terminated by Enter:

```text
PING
SET session user123
GET session
SET token abcxyz EX 10
KEYS
DBSIZE
QUIT
```

## Protocol

The protocol is UTF-8 text. Each request is one CRLF- or LF-terminated line.
Values may contain spaces, but keys may not. Responses use a small RESP-like
shape: `+` for success/string values, `-` for errors, `:` for integers, `$-1`
for a missing key, and `*` for the number of following key rows.

| Command | Purpose |
| --- | --- |
| `PING` | Returns `+PONG`. |
| `AUTH <password>` | Authenticates when a password is configured. |
| `SET <key> <value> [EX seconds]` | Stores a value with an optional positive-integer TTL. |
| `GET <key>` | Returns the value or `$-1`. |
| `DEL <key>` | Deletes a key and returns `:1` or `:0`. |
| `KEYS` | Lists all keys in sorted order. |
| `DBSIZE` | Returns the number of keys. |
| `FLUSHDB` | Deletes every key. |
| `QUIT` | Returns `+OK` and closes the connection. |

When authentication is enabled, clients must run `AUTH` before all commands
except `AUTH` and `QUIT`. Passwords cannot contain whitespace because commands
are whitespace-delimited.

## Configuration

Environment variables control runtime settings:

| Variable | Default | Description |
| --- | --- | --- |
| `MEMORYVAULT_HOST` | `127.0.0.1` | Interface on which the TCP server listens. |
| `MEMORYVAULT_PORT` | `6379` | TCP port from 1 through 65535. |
| `MEMORYVAULT_AOF_PATH` | `./appendonly.aof` beside the source | Durable data file path. |
| `MEMORYVAULT_PASSWORD` | unset | Enables `AUTH` when set. |
| `MEMORYVAULT_MAX_COMMAND_BYTES` | `1048576` | Maximum buffered command size, from 1 KiB to 64 MiB. |

PowerShell example:

```powershell
$env:MEMORYVAULT_PORT = '6380'
$env:MEMORYVAULT_PASSWORD = 'replace-with-a-strong-secret'
npm start
```

Bash example:

```bash
MEMORYVAULT_PORT=6380 \
MEMORYVAULT_PASSWORD='replace-with-a-strong-secret' \
npm start
```

## Durability and TTL behavior

Every mutating command is encoded as a versioned JSON Lines record, written to
the AOF, and synchronized with `fsync` before MemoryVault updates memory and
returns success. On startup, records are replayed in order. A final incomplete
record caused by an interrupted write is ignored; corruption in any complete
record stops startup with a line-numbered error rather than silently loading
incorrect state.

TTL records store an absolute expiration timestamp. A key therefore expires at
the intended time after a restart and is not resurrected if it expired while
the server was offline. The original space-delimited `SET`, `DEL`, and
`FLUSHDB` AOF records remain readable, although that legacy format did not
contain TTL information.

`fsync` substantially improves single-process durability, but MemoryVault is
not a distributed database: it has no replication, clustering, transactions,
or automatic backups. Back up the AOF when those guarantees matter.

## Development

```bash
npm run check
npm test
npm run test:coverage
```

The test suite covers storage operations, AOF replay and corruption handling,
TTL behavior across restarts, TCP fragmentation and pipelining, authentication,
input validation, oversized commands, and connection shutdown. GitHub Actions
runs it on Node.js 18, 20, and 22 on Linux and Windows.

## Security

The safe default is local-only access. If you bind to `0.0.0.0` or another
shared interface, configure authentication and use a private network or a TLS
proxy because this protocol does not provide encryption. See [SECURITY.md](SECURITY.md).

## License

[ISC](LICENSE) © 2026 Sai Vivek
