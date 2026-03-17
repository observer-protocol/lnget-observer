#!/usr/bin/env node
/**
 * lnget-observer v0.1.0
 * Sync lnget L402 payment history to Observer Protocol
 * 
 * Usage:
 *   lnget-observer --agent-id your-agent-001
 *   lnget-observer --agent-id your-agent-001 --watch
 *   lnget-observer --dry-run
 */

import { createRequire } from 'module';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const API_BASE = process.env.OP_API_URL || 'https://api.observerprotocol.org';
const VERSION = '0.1.0';

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    db: join(homedir(), '.lnget', 'events.db'),
    agentId: null,
    dryRun: false,
    watch: false,
    state: join(homedir(), '.lnget-observer', 'state.json'),
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--db':
        options.db = args[++i];
        break;
      case '--agent-id':
        options.agentId = args[++i];
        break;
      case '--state':
        options.state = args[++i];
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--watch':
        options.watch = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
    }
  }

  return options;
}

function showHelp() {
  console.log(`
lnget-observer v${VERSION} — L402 → Observer Protocol

Usage: lnget-observer [options]

Options:
  --db PATH          Path to lnget events.db (default: ~/.lnget/events.db)
  --agent-id ID      Your OP agent ID (optional, auto-creates if needed)
  --state PATH       State file to track synced payments (default: ~/.lnget-observer/state.json)
  --dry-run          Show what would be synced without posting
  --watch            Continuous mode, poll every 30s for new payments
  --help, -h         Show this help

Examples:
  lnget-observer --agent-id my-agent-001
  lnget-observer --agent-id my-agent-001 --watch
  lnget-observer --dry-run
`);
}

// Load state (synced payment hashes)
function loadState(statePath) {
  if (!existsSync(statePath)) {
    return { synced: [] };
  }
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return { synced: [] };
  }
}

// Save state
function saveState(statePath, state) {
  const dir = dirname(statePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// Verify SHA256(preimage) == payment_hash
function verifyPayment(paymentHash, preimage) {
  try {
    const computed = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
    return computed === paymentHash.toLowerCase();
  } catch {
    return false;
  }
}

// Fetch settled payments from lnget database
function fetchPayments(dbPath) {
  if (!existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }

  const db = new Database(dbPath, { readonly: true });
  
  // Check if table exists
  const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get();
  if (!tableCheck) {
    db.close();
    throw new Error("No 'events' table found in database");
  }

  const rows = db.prepare(`
    SELECT 
      id,
      url,
      domain,
      payment_hash,
      preimage,
      amount_msat,
      status,
      created_at,
      macaroon
    FROM events 
    WHERE status = 'settled' 
      AND preimage IS NOT NULL 
      AND preimage != ''
    ORDER BY created_at ASC
  `).all();

  db.close();
  return rows;
}

// Post verified payment to Observer Protocol
async function postToObserver(payment, agentId) {
  const body = {
    agent_id: agentId,
    payment_hash: payment.payment_hash,
    preimage: payment.preimage,
    domain: payment.domain || new URL(payment.url).hostname,
    amount_sats: Math.floor(payment.amount_msat / 1000),
    timestamp: payment.created_at,
    source: 'lnget'
  };

  const response = await fetch(`${API_BASE}/observer/lnget-attest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`HTTP ${response.status}: ${error}`);
  }

  return await response.json();
}

// Format sats with padding
function formatSats(sats) {
  return sats.toString().padStart(4, ' ') + ' sats';
}

// Main sync function
async function sync(options) {
  console.log(`\nlnget-observer v${VERSION} — L402 → Observer Protocol\n`);
  
  const isMock = options.db.includes('mock') || options.db.includes('demo');
  console.log(`📂 Reading: ${options.db}${isMock ? ' (mock demo)' : ''}`);

  let payments;
  try {
    payments = fetchPayments(options.db);
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    process.exit(1);
  }

  console.log(`📊 Found ${payments.length} settled L402 payment${payments.length !== 1 ? 's' : ''}\n`);

  if (payments.length === 0) {
    console.log('No payments to sync.');
    return { synced: 0, skipped: 0, failed: 0 };
  }

  const state = loadState(options.state);
  const results = { synced: 0, skipped: 0, failed: 0, details: [] };

  if (!options.dryRun) {
    console.log('Syncing to Observer Protocol...\n');
  } else {
    console.log('DRY RUN — would sync:\n');
  }

  for (const payment of payments) {
    const domain = payment.domain || (payment.url ? new URL(payment.url).hostname : 'unknown');
    const amountSats = Math.floor(payment.amount_msat / 1000);
    
    // Skip if already synced
    if (state.synced.includes(payment.payment_hash)) {
      console.log(`  ⏭ ${domain.padEnd(28)} ${formatSats(amountSats)}  (already synced)`);
      results.skipped++;
      continue;
    }

    // Verify cryptographically
    const verified = verifyPayment(payment.payment_hash, payment.preimage);
    const verifyIcon = verified ? '✓' : '✗';

    if (options.dryRun) {
      console.log(`  ${verifyIcon} ${domain.padEnd(28)} ${formatSats(amountSats)}  SHA256 ${verifyIcon}  (dry run)`);
      results.details.push({ domain, amountSats, status: 'dry-run' });
      continue;
    }

    if (!verified) {
      console.log(`  ✗ ${domain.padEnd(28)} ${formatSats(amountSats)}  SHA256 ✗  (verification failed)`);
      results.failed++;
      continue;
    }

    // Post to Observer Protocol
    try {
      const result = await postToObserver(payment, options.agentId);
      state.synced.push(payment.payment_hash);
      console.log(`  ✓ ${domain.padEnd(28)} ${formatSats(amountSats)}  SHA256 ✓  → ${result.event_id}`);
      results.synced++;
      results.details.push({ domain, amountSats, eventId: result.event_id, status: 'synced' });
    } catch (err) {
      console.log(`  ✗ ${domain.padEnd(28)} ${formatSats(amountSats)}  ERROR: ${err.message}`);
      results.failed++;
    }
  }

  // Save state
  if (!options.dryRun && results.synced > 0) {
    saveState(options.state, state);
  }

  // Summary
  console.log(`\n${'='.repeat(50)}`);
  if (options.dryRun) {
    console.log(`DRY RUN: Would sync ${payments.length - results.skipped} payments`);
  } else {
    console.log(`✅ ${results.synced} payment${results.synced !== 1 ? 's' : ''} verified and synced to Observer Protocol`);
    if (results.skipped > 0) console.log(`⏭  ${results.skipped} already synced`);
    if (results.failed > 0) console.log(`✗  ${results.failed} failed`);
  }
  
  if (options.agentId && !options.dryRun) {
    console.log(`🔗 View your agent: https://observerprotocol.org/registry`);
  }
  console.log(`\nThe math: SHA256(preimage) = payment_hash — cryptographic proof, no trust required.`);

  return results;
}

// Watch mode
async function watch(options) {
  console.log(`\n👁 Watch mode enabled — polling every 30 seconds`);
  console.log(`Press Ctrl+C to stop\n`);

  while (true) {
    await sync(options);
    console.log(`\n⏳ Waiting 30s...\n`);
    await new Promise(r => setTimeout(r, 30000));
  }
}

// Main
async function main() {
  const options = parseArgs();

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  if (options.watch) {
    await watch(options);
  } else {
    await sync(options);
  }
}

main().catch(err => {
  console.error(`\n❌ Fatal error: ${err.message}`);
  process.exit(1);
});
