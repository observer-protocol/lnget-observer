#!/usr/bin/env node
/**
 * sync-real.mjs — sync real lnget events.db to Observer Protocol
 * Uses Python subprocess to read SQLite (avoids native module issues)
 */
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const API_BASE = 'https://api.observerprotocol.org';
const DB_PATH = process.argv[2] || join(homedir(), '.lnget/events.db');
const AGENT_ID = process.argv[3] || 'maxi-0001';
const STATE_DIR = join(homedir(), '.lnget-observer');
const STATE_FILE = join(STATE_DIR, 'synced.json');

if (!existsSync(DB_PATH)) { console.error(`DB not found: ${DB_PATH}`); process.exit(1); }
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
const synced = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE)) : {};

// Read DB via Python
const rows = JSON.parse(execSync(
  `python3 -c "import sqlite3,json; c=sqlite3.connect('${DB_PATH}'); ` +
  `rows=c.execute('SELECT url,domain,payment_hash,preimage,amount_msat,status,created_at FROM events WHERE status=\\'settled\\' AND preimage IS NOT NULL AND preimage!=\\'\\'').fetchall(); ` +
  `print(json.dumps([dict(zip(['url','domain','payment_hash','preimage','amount_msat','status','created_at'],r)) for r in rows]))"`,
  { encoding: 'utf8' }
));

console.log(`\nlnget-observer v0.1.0 — L402 → Observer Protocol`);
console.log('═'.repeat(55));
console.log(`📂 Reading: ${DB_PATH}`);
console.log(`📊 Found ${rows.length} settled L402 payments\n`);
console.log('Syncing to Observer Protocol...\n');

let newCount = 0, skipCount = 0, failCount = 0;

for (const row of rows) {
  const key = row.payment_hash;
  if (synced[key]) { skipCount++; continue; }
  
  // Verify SHA256
  const computed = createHash('sha256').update(Buffer.from(row.preimage, 'hex')).digest('hex');
  const valid = computed === row.payment_hash;
  
  const amountSats = Math.round((row.amount_msat || 0) / 1000);
  const domainStr = (row.domain || row.url || 'unknown').padEnd(35);
  
  if (!valid) {
    console.log(`  ✗ ${domainStr} ${String(amountSats+' sats').padStart(8)}  SHA256 ✗ SKIP`);
    failCount++; continue;
  }
  
  try {
    const res = await fetch(`${API_BASE}/observer/lnget-attest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payment_hash: row.payment_hash,
        preimage: row.preimage,
        domain: row.domain || new URL(row.url).hostname,
        amount_sats: amountSats,
        timestamp: row.created_at,
        agent_id: AGENT_ID,
        source: 'lnget'
      })
    });
    const data = await res.json();
    const eventId = data.event_id || '—';
    console.log(`  ✓ ${domainStr} ${String(amountSats+' sats').padStart(8)}  SHA256 ✓  → ${eventId}`);
    synced[key] = { eventId, ts: new Date().toISOString() };
    newCount++;
  } catch(e) {
    console.log(`  ✗ ${domainStr} POST failed: ${e.message}`);
    failCount++;
  }
}

writeFileSync(STATE_FILE, JSON.stringify(synced, null, 2));
console.log(`\n${'─'.repeat(55)}`);
console.log(`✅ ${newCount} new payments synced · ${skipCount} already synced · ${failCount} failed`);
if (newCount > 0) console.log(`🔗 View: https://observerprotocol.org/registry`);
console.log(`\nSHA256(preimage) = payment_hash — cryptographic proof. No trust required.\n`);
