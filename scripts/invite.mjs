#!/usr/bin/env node
/**
 * Invite codes: mint, list, revoke. Codes are single use -- one code buys one
 * account, and redeeming it spends it.
 *
 * Usage:
 *   npm run invite                          # mint one code
 *   npm run invite -- 5                     # mint five
 *   npm run invite -- --note "for Bob"      # mint one, with a reminder attached
 *   npm run invite -- --list                # show every code and its state
 *   npm run invite -- --revoke <code>       # delete an unused code
 *
 * Add --local to operate on the local development database.
 */
import { spawnSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';

const argv = process.argv.slice(2);
const local = argv.includes('--local');
const listing = argv.includes('--list');
const valueOf = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
const revoking = valueOf('--revoke');
const note = valueOf('--note');
const count = Number(argv.find((arg) => /^\d+$/.test(arg)) ?? 1);

// Crockford base32, as in lib/crypto.ts: no i, l, o or u, so a code can be read
// down a phone line without ambiguity. 16 characters is 80 bits.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const CODE_CHARS = 16;

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

function d1(sql) {
  const result = spawnSync(
    'npx',
    [
      'wrangler', 'd1', 'execute', 'ratatoskr',
      local ? '--local' : '--remote',
      '--command', sql, '--json',
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    process.exit(1);
  }
  return JSON.parse(result.stdout);
}

function generateCode() {
  const bytes = webcrypto.getRandomValues(new Uint8Array(CODE_CHARS));
  return [...bytes]
    .map((byte) => ALPHABET[byte % 32])
    .join('')
    .match(/.{4}/g)
    .join('-');
}

/* ---------------------------------------------------------------- */

if (listing) {
  const [{ results }] = d1(
    'SELECT code, note, created_at, used_at, used_by FROM invites ORDER BY used_at IS NOT NULL, created_at DESC;',
  );
  if (!results.length) {
    console.log('\nNo invite codes. Mint one with `npm run invite`.\n');
    process.exit(0);
  }
  const date = (ms) => new Date(ms).toISOString().slice(0, 10);
  console.log();
  for (const invite of results) {
    const state = invite.used_at
      ? `\x1b[2mused ${date(invite.used_at)}\x1b[0m`
      : '\x1b[1munused\x1b[0m';
    console.log(`  ${invite.code}  ${state}${invite.note ? `  ${invite.note}` : ''}`);
  }
  const unused = results.filter((invite) => !invite.used_at).length;
  console.log(`\n${unused} unused, ${results.length - unused} spent.\n`);
  process.exit(0);
}

if (revoking) {
  // Only unused codes: revoking a spent one would free the code to be redeemed
  // a second time. `wrangler d1 execute` reports no row count, so ask SQLite --
  // the same trick reset-password.mjs uses.
  const deleted = d1(
    `DELETE FROM invites WHERE code = ${quote(revoking)} AND used_at IS NULL;
     SELECT changes() AS deleted;`,
  ).at(-1)?.results?.[0]?.deleted;
  if (!deleted) {
    console.error(`\nNo unused invite code ${revoking}. A code that has been used cannot be revoked.\n`);
    process.exit(1);
  }
  console.log(`\nRevoked ${revoking}.\n`);
  process.exit(0);
}

const codes = Array.from({ length: count }, generateCode);
const now = Date.now();
d1(
  `INSERT INTO invites (code, note, created_at) VALUES ${codes
    .map((code) => `(${quote(code)}, ${note === null ? 'NULL' : quote(note)}, ${now})`)
    .join(', ')};`,
);

console.log(`\n${codes.length === 1 ? 'Invite code' : 'Invite codes'}:\n`);
for (const code of codes) console.log(`  \x1b[1m${code}\x1b[0m`);
console.log('\nEach code registers exactly one account.\n');
