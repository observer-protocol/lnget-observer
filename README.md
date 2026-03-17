# lnget-observer

> Turn your lnget L402 payment history into a portable, verifiable agent reputation.

lnget already logs every L402 payment you make. lnget-observer syncs those payments 
to Observer Protocol — giving your agent a cryptographically verified reputation 
built from real transactions.

## Quick Start

```bash
# Install
npm install -g lnget-observer  # (or: node lnget-observer.mjs)

# Sync your lnget payment history to Observer Protocol
lnget-observer --agent-id your-agent-001

# Watch mode — continuously sync new payments
lnget-observer --agent-id your-agent-001 --watch

# Dry run — see what would be synced
lnget-observer --dry-run
```

## How it works

1. Reads `~/.lnget/events.db` (lnget's local SQLite database)
2. Verifies each payment cryptographically: SHA256(preimage) = payment_hash
3. Posts verified payments to Observer Protocol
4. Your agent now has a public, verifiable payment history

## The insight

Every lnget user already has a verifiable payment history — it's just sitting in a 
local SQLite file. lnget-observer makes it public and portable.

Once synced, anyone can verify your agent's payment history at:
https://observerprotocol.org/registry

## Installation

```bash
npm install -g lnget-observer
```

Or run directly without installing:

```bash
npx lnget-observer --agent-id your-agent-001
```

## Usage

### Basic sync

```bash
lnget-observer --agent-id my-agent
```

### Watch mode (continuous)

```bash
lnget-observer --agent-id my-agent --watch
```

### Dry run (see what would sync)

```bash
lnget-observer --dry-run
```

### Custom database path

```bash
lnget-observer --db /path/to/events.db --agent-id my-agent
```

### Custom state file

```bash
lnget-observer --state /path/to/state.json --agent-id my-agent
```

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `--db PATH` | Path to lnget events.db | `~/.lnget/events.db` |
| `--agent-id ID` | Your OP agent ID | Auto-generated |
| `--state PATH` | State file for tracking synced payments | `~/.lnget-observer/state.json` |
| `--dry-run` | Show what would sync without posting | `false` |
| `--watch` | Continuous mode, poll every 30s | `false` |
| `--help` | Show help | - |

## Demo Mode

Run the demo to see lnget-observer in action with mock data:

```bash
npm run demo
# or
node demo-mode.mjs
```

## Requirements

- Node.js 18+
- lnget installed (or use demo mode)
- `better-sqlite3` dependency (auto-installed)

## How verification works

lnget-observer uses the fundamental property of Lightning Network payments:

```
SHA256(preimage) = payment_hash
```

When a Lightning payment succeeds, the recipient reveals the preimage. 
Anyone can verify the payment occurred by checking that SHA256(preimage) 
equals the original payment_hash. This is cryptographic proof — no trust required.

## API

lnget-observer posts to the Observer Protocol API:

```
POST https://api.observerprotocol.org/observer/lnget-attest
```

Body:
```json
{
  "agent_id": "your-agent-id",
  "payment_hash": "hex string",
  "preimage": "hex string",
  "domain": "api.example.com",
  "amount_sats": 100,
  "timestamp": "2024-01-15T10:30:00Z",
  "source": "lnget"
}
```

## License

MIT
