#!/usr/bin/env node
/**
 * Creates the administrator account. This is the one account that is not
 * registered through the web interface: there is nobody to issue it an invite
 * code, so `npm run setup` creates it directly at deployment.
 *
 * It is an ordinary account with `is_admin` set -- same login, same token, same
 * character in game -- and it is what unlocks the administration view.
 *
 * Usage:
 *   npm run create-admin -- <email> <character-name> [--local]
 */
import { spawnSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';

const argv = process.argv.slice(2);
const local = argv.includes('--local');
const [email, name] = argv.filter((arg) => !arg.startsWith('--'));

if (!email || !name) {
  console.error('usage: npm run create-admin -- <email> <character-name> [--local]');
  process.exit(1);
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error(`Not an email address: ${email}`);
  process.exit(1);
}
if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
  console.error('Character name must be 3-16 characters of A-Z, 0-9 or _.');
  process.exit(1);
}

// Must stay in step with src/lib/crypto.ts -- same alphabet, same length, same
// stored format. See the comment there for why a plain salted hash is enough.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const PASSWORD_CHARS = 20;

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

/* ---------------------------------------------------------------- */

// One administrator is enough, and re-running setup must not quietly mint a
// second one. Promoting an existing account is a deliberate, separate act:
//   wrangler d1 execute ratatoskr --remote \
//     --command "UPDATE users SET is_admin = 1 WHERE email_lower = '...';"
const [{ results: existing }] = d1('SELECT email FROM users WHERE is_admin = 1 LIMIT 1;');
if (existing.length) {
  console.log(`\nAdministrator already exists: ${existing[0].email}. Nothing to do.\n`);
  process.exit(0);
}

const bytes = webcrypto.getRandomValues(new Uint8Array(PASSWORD_CHARS));
const password = [...bytes]
  .map((byte) => ALPHABET[byte % 32])
  .join('')
  .match(/.{4}/g)
  .join('-');

const salt = webcrypto.getRandomValues(new Uint8Array(16));
const digest = new Uint8Array(
  await webcrypto.subtle.digest('SHA-256', Buffer.concat([Buffer.from(salt), Buffer.from(password, 'utf8')])),
);
const hash = `sha256$${Buffer.from(salt).toString('base64')}$${Buffer.from(digest).toString('base64')}`;

const userId = webcrypto.randomUUID();
const profileId = webcrypto.randomUUID();
const now = Date.now();

const [, , { results }] = d1(`
INSERT INTO users (id, email, email_lower, password_hash, created_at, is_admin)
VALUES (${quote(userId)}, ${quote(email)}, ${quote(email.toLowerCase())}, ${quote(hash)}, ${now}, 1);
INSERT INTO profiles (id, user_id, name, name_lower, skin_model, created_at)
VALUES (${quote(profileId)}, ${quote(userId)}, ${quote(name)}, ${quote(name.toLowerCase())}, 'default', ${now});
SELECT changes() AS created;`);

if (!results?.[0]?.created) {
  console.error('\nThe account was not created. Is the character name or email already taken?\n');
  process.exit(1);
}

console.log(`\nAdministrator \x1b[1m${name}\x1b[0m <${email}>`);
console.log(`\n  password: \x1b[1m${password}\x1b[0m\n`);
console.log('Save it now: it is stored only as a hash and is shown just this once.');
console.log('Sign in with it on the site to reach the administration view.\n');
