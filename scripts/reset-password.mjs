#!/usr/bin/env node
/**
 * Issues a new password for a character. There is deliberately no reset
 * endpoint -- password recovery is an operator action, not a public one.
 *
 * Usage:
 *   npm run reset-password -- Steve          # against the deployed database
 *   npm run reset-password -- Steve --local  # against the local dev database
 */
import { spawnSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';

const args = process.argv.slice(2);
const local = args.includes('--local');
const name = args.find((arg) => !arg.startsWith('--'));

if (!name) {
  console.error('usage: npm run reset-password -- <character-name> [--local]');
  process.exit(1);
}

// Must stay in step with src/lib/crypto.ts -- same alphabet, same length,
// same stored format. See the comment there for why a plain hash is enough.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const CHARS = 20;

const bytes = webcrypto.getRandomValues(new Uint8Array(CHARS));
const password = [...bytes]
  .map((byte) => ALPHABET[byte % 32])
  .join('')
  .match(/.{4}/g)
  .join('-');

const salt = webcrypto.getRandomValues(new Uint8Array(16));
const input = Buffer.concat([Buffer.from(salt), Buffer.from(password, 'utf8')]);
const digest = new Uint8Array(await webcrypto.subtle.digest('SHA-256', input));
const hash = `sha256$${Buffer.from(salt).toString('base64')}$${Buffer.from(digest).toString('base64')}`;

const sql = `
UPDATE users SET password_hash = '${hash}'
WHERE id = (SELECT user_id FROM profiles WHERE name_lower = '${name.toLowerCase().replace(/'/g, "''")}');
SELECT changes() AS updated;`;

const result = spawnSync(
  'npx',
  ['wrangler', 'd1', 'execute', 'ratatoskr', local ? '--local' : '--remote', '--command', sql, '--json'],
  { encoding: 'utf8' },
);

if (result.status !== 0) {
  console.error(result.stderr || result.stdout);
  process.exit(1);
}

// The last statement's `changes()` tells us whether the character existed.
const updated = JSON.parse(result.stdout).at(-1)?.results?.[0]?.updated;
if (!updated) {
  console.error(`No character named ${name}.`);
  process.exit(1);
}

// Existing sessions were signed with the old password only in the sense that
// they predate it -- they stay valid, so kick them too.
spawnSync(
  'npx',
  [
    'wrangler', 'd1', 'execute', 'ratatoskr', local ? '--local' : '--remote', '--command',
    `DELETE FROM tokens WHERE user_id = (SELECT user_id FROM profiles WHERE name_lower = '${name.toLowerCase().replace(/'/g, "''")}');`,
  ],
  { encoding: 'utf8' },
);

console.log(`\nNew password for ${name}:\n\n  \x1b[1m${password}\x1b[0m\n`);
console.log('Existing logins have been signed out. This is the only time the password is shown.\n');
