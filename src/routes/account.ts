import { Hono } from 'hono';
import { generatePassword, hashPassword } from '../lib/crypto';
import { claimInvite, findProfileByName, findUserByEmail, releaseInvite } from '../lib/db';
import { badRequest, forbidden } from '../lib/errors';
import { minimalProfile } from '../lib/profile';
import { randomUuid } from '../lib/uuid';
import type { Env, Profile } from '../types';

const NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;

interface RegisterRequest {
  email?: string;
  profileName?: string;
  inviteCode?: string;
}

export const account = new Hono<{ Bindings: Env }>();

/**
 * The password is generated here rather than chosen, which is what lets us
 * store it as a plain salted hash (see lib/crypto). It is returned exactly
 * once, in this response, and cannot be recovered afterwards -- resets go
 * through `npm run reset-password`.
 *
 * Invite codes are single use. Registration therefore has an ordering problem:
 * the code must be claimed before the account is written (or two people could
 * spend it at once), but the write may still fail on a name collision. So the
 * claim is undone if it does. The window in which a code is spent but unusable
 * is one failed INSERT wide.
 */
account.post('/register', async (c) => {
  const body = await c.req.json<RegisterRequest>().catch(() => ({}) as RegisterRequest);
  const { email, profileName, inviteCode } = body;

  if (!inviteCode) throw forbidden('An invite code is required.');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('Invalid email address.');
  if (!profileName || !NAME_PATTERN.test(profileName)) {
    throw badRequest('Character name must be 3-16 characters of A-Z, 0-9 or _.');
  }

  if (await findUserByEmail(c.env, email)) throw badRequest('That email is already registered.');
  if (await findProfileByName(c.env, profileName)) throw badRequest('That character name is taken.');

  const now = Date.now();
  const userId = randomUuid();
  const profile: Profile = {
    id: randomUuid(),
    user_id: userId,
    name: profileName,
    name_lower: profileName.toLowerCase(),
    skin_hash: null,
    skin_model: 'default',
    cape_hash: null,
    created_at: now,
  };

  if (!(await claimInvite(c.env, inviteCode, userId, now))) {
    throw forbidden('That invite code is invalid or has already been used.');
  }

  const password = generatePassword();
  const passwordHash = await hashPassword(password);

  // UNIQUE on email_lower / name_lower is what actually settles a race between
  // two simultaneous registrations; the checks above are just for nice errors.
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO users (id, email, email_lower, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(userId, email, email.toLowerCase(), passwordHash, now),
      c.env.DB.prepare(
        'INSERT INTO profiles (id, user_id, name, name_lower, skin_model, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(profile.id, userId, profile.name, profile.name_lower, profile.skin_model, now),
    ]);
  } catch (error) {
    await releaseInvite(c.env, inviteCode);
    if (String(error).includes('UNIQUE')) throw badRequest('That email or character name is taken.');
    throw error;
  }

  return c.json({ user: { id: userId, email }, profile: minimalProfile(profile), password }, 201);
});
