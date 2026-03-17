#!/usr/bin/env node
/**
 * demo-mode.mjs — Demo script for Lightning Labs presentation
 *
 * Creates a mock lnget events.db with 5 sample L402 payments,
 * then runs the sync flow against the REAL Observer Protocol API.
 *
 * Uses Node.js 22 built-in SQLite — zero dependencies required.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const API_BASE = process.env.OP_API_URL || 'https://api.observerprotocol.org';
const VERSION = '0.1.0';

const DEMO_PAYMENTS = [
  { domain: 'api.example.com',          amountSats: 100, url: 'https://api.example.com/v1/data' },
  { domain: 'data.bitcoinprice.io',     amountSats:  21, url: 'https://data.bitcoinprice.io/price' },
  { domain: 'api.lightning.ai',         amountSats:  50, url: 'https://api.lightning.ai/generate' },
  { domain: 'api.observerprotocol.org', amountSats:   1, url: 'https://api.observerprotocol.org/observer/ask' },
  { domain: 'feeds.stacker.news',       amountSats:  10, url: 'https://feeds.stacker.news/rss' },
];

function generatePayment() {
  const preimage    = randomBytes(32).toString('hex');
  const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
  return { preimage, paymentHash };
}

function createMockDb(dbPath) {
  if (existsSync(dbPath)) rmSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      url          TEXT,
      domain       TEXT,
      payment_hash TEXT,
      preimage     TEXT,
      amount_msat  INTEGER,
      status       TEXT,
      created_at   TEXT,
      macaroon     TEXT
    )
  `);
  const insert = db.prepare(
    `INSERT INTO events (url, domain, payment_hash, preimage, amount_msat, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'settled', ?)`
  );
  for (const p of DEMO_PAYMENTS) {
    const { preimage, paymentHash } = generatePayment();
    insert.run(p.url, p.domain, paymentHash, preimage, p.amountSats * 1000,
               new Date().toISOString());
  }
  db.close();
}

async function attestPayment(row) {
  const res = await fetch(`${API_BASE}/observer/lnget-attest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      payment_hash: row.payment_hash,
      preimage:     row.preimage,
      domain:       row.domain,
      amount_sats:  Math.floor(row.amount_msat / 1000),
      timestamp:    row.created_at,
      source:       'lnget',
    }),
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}

function pad(str, len) { return String(str).padEnd(len); }
function lpad(str, len) { return String(str).padStart(len); }

async function main() {
  console.log(`\nlnget-observer v${VERSION} — L402 → Observer Protocol`);
  console.log('═'.repeat(55));
  console.log('DEMO MODE — Lightning Labs Presentation\n');

  const dbDir  = join(homedir(), '.lnget');
  const dbPath = join(dbDir, 'events.db');
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

  console.log('📂 Setting up demo environment...');
  createMockDb(dbPath);
  console.log(`   Created mock DB: ${dbPath}`);

  const db   = new DatabaseSync(dbPath);
  const rows = db.prepare(
    `SELECT * FROM events WHERE status='settled' AND preimage IS NOT NULL`
  ).all();
  db.close();

  console.log(`\n📊 Found ${rows.length} settled L402 payments\n`);
  console.log('Syncing to Observer Protocol...\n');

  let synced = 0, failed = 0;
  for (const row of rows) {
    const verify = createHash('sha256')
      .update(Buffer.from(row.preimage, 'hex')).digest('hex') === row.payment_hash;

    if (!verify) {
      console.log(`  ✗ ${pad(row.domain, 30)} SHA256 FAIL — skipped`);
      failed++;
      continue;
    }

    const result = await attestPayment(row);
    const eventId = result.body.event_id || '—';

    if (result.ok) {
      console.log(
        `  ✓ ${pad(row.domain, 30)} ${lpad(Math.floor(row.amount_msat/1000)+' sats', 8)}` +
        `  SHA256 ✓  → ${eventId}`
      );
      synced++;
    } else {
      console.log(
        `  ✗ ${pad(row.domain, 30)} ${lpad(Math.floor(row.amount_msat/1000)+' sats', 8)}` +
        `  HTTP ${result.status}`
      );
      failed++;
    }
  }

  console.log(`\n${'─'.repeat(55)}`);
  if (synced > 0) {
    console.log(`✅ ${synced} payment${synced!==1?'s':''} verified and synced to Observer Protocol`);
  }
  if (failed > 0) {
    console.log(`⚠️  ${failed} payment${failed!==1?'s':''} failed`);
  }
  console.log(`\n🔗 View live feed:  https://observerprotocol.org/demo`);
  console.log(`🔗 Registry:        https://observerprotocol.org/registry`);
  console.log(`\nThe math: SHA256(preimage) = payment_hash`);
  console.log('Cryptographic proof. No trust required.\n');
}

main().catch(e => { console.error('Demo failed:', e.message); process.exit(1); });
