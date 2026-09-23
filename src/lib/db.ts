import type { Account, BridgedProfile, Env, Invite, Profile, Token, User } from '../types';

export const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function findUserByEmail(env: Env, email: string): Promise<User | null> {
  return env.DB.prepare('SELECT * FROM users WHERE email_lower = ?')
    .bind(email.toLowerCase())
    .first<User>();
}

export function findUserById(env: Env, id: string): Promise<User | null> {
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>();
}

/** Yggdrasil allows logging in with the character name instead of the email. */
export function findUserByProfileName(env: Env, name: string): Promise<User | null> {
  return env.DB.prepare(
    'SELECT users.* FROM users JOIN profiles ON profiles.user_id = users.id WHERE profiles.name_lower = ?',
  )
    .bind(name.toLowerCase())
    .first<User>();
}

export function findProfileById(env: Env, id: string): Promise<Profile | null> {
  return env.DB.prepare('SELECT * FROM profiles WHERE id = ?').bind(id).first<Profile>();
}

export function findProfileByName(env: Env, name: string): Promise<Profile | null> {
  return env.DB.prepare('SELECT * FROM profiles WHERE name_lower = ?')
    .bind(name.toLowerCase())
    .first<Profile>();
}

export async function findProfilesByUser(env: Env, userId: string): Promise<Profile[]> {
  const { results } = await env.DB.prepare('SELECT * FROM profiles WHERE user_id = ?')
    .bind(userId)
    .all<Profile>();
  return results;
}

export async function findProfilesByNames(env: Env, names: string[]): Promise<Profile[]> {
  if (names.length === 0) return [];
  const placeholders = names.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT * FROM profiles WHERE name_lower IN (${placeholders})`,
  )
    .bind(...names.map((name) => name.toLowerCase()))
    .all<Profile>();
  return results;
}

/**
 * Spends an invite code, returning false if there was nothing to spend.
 *
 * The UPDATE *is* the check: `WHERE used_at IS NULL` means SQLite settles the
 * race between two people redeeming the same code, and `changes` tells us which
 * of them won. Reading the row first and updating it afterwards would let both
 * through.
 */
export async function claimInvite(
  env: Env,
  code: string,
  userId: string,
  now: number,
): Promise<boolean> {
  const { meta } = await env.DB.prepare(
    'UPDATE invites SET used_at = ?, used_by = ? WHERE code = ? AND used_at IS NULL',
  )
    .bind(now, userId, code)
    .run();
  return meta.changes === 1;
}

/** Puts a claimed code back, for when the registration it was claimed for failed. */
export async function releaseInvite(env: Env, code: string): Promise<void> {
  await env.DB.prepare('UPDATE invites SET used_at = NULL, used_by = NULL WHERE code = ?')
    .bind(code)
    .run();
}

export async function listInvites(env: Env): Promise<Invite[]> {
  const { results } = await env.DB.prepare(
    // Unused first, newest first within each group: what an operator wants to
    // see is the codes they can still hand out.
    'SELECT * FROM invites ORDER BY used_at IS NOT NULL, created_at DESC',
  ).all<Invite>();
  return results;
}

export async function createInvites(
  env: Env,
  codes: string[],
  note: string | null,
  now: number,
): Promise<void> {
  await env.DB.batch(
    codes.map((code) =>
      env.DB.prepare('INSERT INTO invites (code, note, created_at) VALUES (?, ?, ?)').bind(
        code,
        note,
        now,
      ),
    ),
  );
}

/** Unused codes only: deleting a spent one would free it to be redeemed again. */
export async function revokeInvite(env: Env, code: string): Promise<boolean> {
  const { meta } = await env.DB.prepare('DELETE FROM invites WHERE code = ? AND used_at IS NULL')
    .bind(code)
    .run();
  return meta.changes === 1;
}

/* ---------------- administration ---------------- */

export async function listAccounts(env: Env): Promise<Account[]> {
  const { results } = await env.DB.prepare(
    `SELECT users.id, users.email, users.created_at, users.is_admin,
            profiles.id AS profile_id, profiles.name AS profile_name
     FROM users LEFT JOIN profiles ON profiles.user_id = users.id
     ORDER BY users.created_at`,
  ).all<Account>();
  return results;
}

/**
 * The schema cascades from users, but D1 does not enable foreign keys on every
 * path, so the dependents are removed explicitly and in one batch.
 */
export async function deleteAccount(env: Env, userId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM tokens WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM profiles WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);
}

/** Replaces the password and signs the account out everywhere it is logged in. */
export async function replacePassword(env: Env, userId: string, hash: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, userId),
    env.DB.prepare('DELETE FROM tokens WHERE user_id = ?').bind(userId),
  ]);
}

export async function createToken(
  env: Env,
  userId: string,
  clientToken: string,
  profileId: string | null,
  accessToken: string,
  now: number,
): Promise<Token> {
  const token: Token = {
    access_token: accessToken,
    client_token: clientToken,
    user_id: userId,
    profile_id: profileId,
    issued_at: now,
    expires_at: now + TOKEN_TTL_MS,
  };
  await env.DB.prepare(
    'INSERT INTO tokens (access_token, client_token, user_id, profile_id, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(
      token.access_token,
      token.client_token,
      token.user_id,
      token.profile_id,
      token.issued_at,
      token.expires_at,
    )
    .run();
  return token;
}

/** Returns the token only if it exists and has not expired. */
export async function findValidToken(env: Env, accessToken: string, now: number): Promise<Token | null> {
  const token = await env.DB.prepare('SELECT * FROM tokens WHERE access_token = ?')
    .bind(accessToken)
    .first<Token>();
  if (!token) return null;
  if (token.expires_at <= now) {
    await deleteToken(env, accessToken);
    return null;
  }
  return token;
}

export async function deleteToken(env: Env, accessToken: string): Promise<void> {
  await env.DB.prepare('DELETE FROM tokens WHERE access_token = ?').bind(accessToken).run();
}

export async function deleteTokensForUser(env: Env, userId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM tokens WHERE user_id = ?').bind(userId).run();
}

/* ---------------- bridge mode ---------------- */

export function findBridgedById(env: Env, id: string): Promise<BridgedProfile | null> {
  return env.DB.prepare('SELECT * FROM bridged_profiles WHERE id = ?').bind(id).first<BridgedProfile>();
}

export function findBridgedByName(env: Env, name: string): Promise<BridgedProfile | null> {
  return env.DB.prepare('SELECT * FROM bridged_profiles WHERE name_lower = ?')
    .bind(name.toLowerCase())
    .first<BridgedProfile>();
}

export async function findBridgedByNames(env: Env, names: string[]): Promise<BridgedProfile[]> {
  if (names.length === 0) return [];
  const placeholders = names.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT * FROM bridged_profiles WHERE name_lower IN (${placeholders})`,
  )
    .bind(...names.map((name) => name.toLowerCase()))
    .all<BridgedProfile>();
  return results;
}

export async function listBridged(env: Env): Promise<BridgedProfile[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM bridged_profiles ORDER BY last_seen DESC',
  ).all<BridgedProfile>();
  return results;
}

/**
 * Records a bridged player, or refreshes one already on record. Returns false
 * when the name or the uuid is held by someone else.
 *
 * As with invites, the UNIQUE constraints settle races: the reads before the
 * write only decide which write to attempt.
 */
export async function claimBridged(
  env: Env,
  source: string,
  id: string,
  name: string,
  now: number,
): Promise<boolean> {
  const byName = await findBridgedByName(env, name);
  if (byName && (byName.id !== id || byName.source !== source)) return false;

  const byId = byName ?? (await findBridgedById(env, id));
  // The same uuid arriving from a different service is not the same player.
  if (byId && byId.source !== source) return false;

  try {
    if (byId) {
      // Covers both a returning player and one who renamed upstream.
      await env.DB.prepare(
        'UPDATE bridged_profiles SET name = ?, name_lower = ?, last_seen = ? WHERE id = ?',
      )
        .bind(name, name.toLowerCase(), now, id)
        .run();
    } else {
      await env.DB.prepare(
        'INSERT INTO bridged_profiles (id, source, name, name_lower, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)',
      )
        .bind(id, source, name, name.toLowerCase(), now, now)
        .run();
    }
  } catch (error) {
    if (String(error).includes('UNIQUE')) return false;
    throw error;
  }
  return true;
}

export async function releaseBridged(env: Env, id: string): Promise<boolean> {
  const { meta } = await env.DB.prepare('DELETE FROM bridged_profiles WHERE id = ?').bind(id).run();
  return meta.changes === 1;
}
