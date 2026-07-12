#!/usr/bin/env node
/**
 * One-shot provisioning: create the D1 database and KV namespace, write their
 * ids into wrangler.jsonc, run the migrations, set the signing key, deploy, and
 * create the administrator account.
 *
 * Safe to re-run -- everything here checks for what already exists first.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CONFIG = new URL('../wrangler.jsonc', import.meta.url);
const DB_NAME = 'ratatoskr';
const KV_TITLE = 'ratatoskr-KV';

const wrangler = (args, options = {}) =>
  execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', ...options });

const step = (message) => console.log(`\n\x1b[1m▸ ${message}\x1b[0m`);

function readConfig() {
  return readFileSync(CONFIG, 'utf8');
}

/** Replaces a single `"key": "REPLACE_ME"` placeholder, keeping comments intact. */
function writeBinding(key, id) {
  const config = readConfig();
  const pattern = new RegExp(`("${key}"\\s*:\\s*)"REPLACE_ME"`);
  if (!pattern.test(config)) return false;
  writeFileSync(CONFIG, config.replace(pattern, `$1"${id}"`));
  return true;
}

function hasPlaceholder(key) {
  return new RegExp(`"${key}"\\s*:\\s*"REPLACE_ME"`).test(readConfig());
}

/* ---------------------------------------------------------------- */

step('Checking Cloudflare login');
try {
  wrangler(['whoami'], { stdio: 'pipe' });
} catch {
  console.error('Not logged in. Run `npx wrangler login` first.');
  process.exit(1);
}

step('D1 database');
if (hasPlaceholder('database_id')) {
  const databases = JSON.parse(wrangler(['d1', 'list', '--json'], { stdio: 'pipe' }) || '[]');
  let database = databases.find((d) => d.name === DB_NAME);
  if (database) {
    console.log(`  reusing existing database ${DB_NAME}`);
  } else {
    wrangler(['d1', 'create', DB_NAME], { stdio: 'pipe' });
    const refreshed = JSON.parse(wrangler(['d1', 'list', '--json'], { stdio: 'pipe' }));
    database = refreshed.find((d) => d.name === DB_NAME);
    console.log(`  created database ${DB_NAME}`);
  }
  writeBinding('database_id', database.uuid);
} else {
  console.log('  already configured');
}

step('KV namespace');
if (hasPlaceholder('id')) {
  const namespaces = JSON.parse(wrangler(['kv', 'namespace', 'list'], { stdio: 'pipe' }) || '[]');
  let namespace = namespaces.find((n) => n.title === KV_TITLE);
  if (namespace) {
    console.log(`  reusing existing namespace ${KV_TITLE}`);
  } else {
    wrangler(['kv', 'namespace', 'create', 'KV'], { stdio: 'pipe' });
    const refreshed = JSON.parse(wrangler(['kv', 'namespace', 'list'], { stdio: 'pipe' }));
    namespace = refreshed.find((n) => n.title === KV_TITLE);
    console.log(`  created namespace ${KV_TITLE}`);
  }
  writeBinding('id', namespace.id);
} else {
  console.log('  already configured');
}

step('Running migrations');
spawnSync('npx', ['wrangler', 'd1', 'migrations', 'apply', DB_NAME, '--remote'], {
  stdio: 'inherit',
});

step('Signing key');
// The RSA key exists only as a secret: generated here, piped straight to
// Cloudflare, never written to disk.
const signingKey = execFileSync('node', [new URL('keygen.mjs', import.meta.url).pathname], {
  encoding: 'utf8',
});
spawnSync('npx', ['wrangler', 'secret', 'put', 'SIGNING_KEY'], {
  input: signingKey,
  stdio: ['pipe', 'inherit', 'inherit'],
});
console.log('  SIGNING_KEY set (freshly generated RSA key)');

// A local mirror, so `npm run dev` works without extra steps.
if (!existsSync(new URL('../.dev.vars', import.meta.url))) {
  writeFileSync(
    new URL('../.dev.vars', import.meta.url),
    // dotenv expands \n inside double quotes, which keeps the PEM on one line.
    `SIGNING_KEY="${signingKey.trimEnd().replace(/\n/g, '\\n')}"\n`,
  );
  console.log('  wrote .dev.vars for local development');
}

step('Deploying');
spawnSync('npx', ['wrangler', 'deploy'], { stdio: 'inherit' });

// The administrator is the first account, and the only one nobody can invite --
// so it is created here rather than registered. Signing in with it unlocks the
// administration view, where every further account and invite is managed.
step('Administrator account');
const rl = createInterface({ input: process.stdin, output: process.stdout });
const email = (await rl.question('  Email address: ')).trim();
const name = (await rl.question('  Character name: ')).trim();
rl.close();

const admin = spawnSync(
  'node',
  [new URL('create-admin.mjs', import.meta.url).pathname, email, name],
  { stdio: 'inherit' },
);
if (admin.status !== 0) {
  console.error('\nThe service is deployed, but has no administrator yet. Retry with:');
  console.error('  npm run create-admin -- <email> <character-name>\n');
  process.exit(1);
}

console.log('\x1b[1mDone.\x1b[0m Sign in on the site above to reach the administration view,');
console.log('where invite codes are issued. Launchers and authlib-injector point at');
console.log('  <worker-url>/api/yggdrasil\n');
