import { Hono } from 'hono';
import { generateInviteCode, generatePassword, hashPassword } from '../lib/crypto';
import {
  createInvites,
  deleteAccount,
  findUserById,
  findValidToken,
  listAccounts,
  listInvites,
  replacePassword,
  revokeInvite,
} from '../lib/db';
import { badRequest, forbidden, invalidToken } from '../lib/errors';
import { dash, isUuid } from '../lib/uuid';
import type { Env, User } from '../types';

const MAX_INVITES_PER_REQUEST = 20;
const MAX_NOTE_LENGTH = 100;

/**
 * Administration. The administrator is an ordinary account carrying `is_admin`,
 * so there is no second kind of credential to manage: the bearer token here is
 * the same Yggdrasil access token the game uses. The first account, created at
 * deployment by `npm run setup`, is the administrator.
 *
 * Everything here also exists as a script (`npm run invite`,
 * `npm run reset-password`, `npm run create-admin`), which stays the way back in
 * if the administrator ever locks themselves out.
 */
export const admin = new Hono<{ Bindings: Env; Variables: { admin: User } }>();

admin.use('*', async (c, next) => {
  const match = c.req.header('authorization')?.match(/^Bearer\s+(\S+)$/i);
  if (!match) throw invalidToken();

  const token = await findValidToken(c.env, match[1]!, Date.now());
  if (!token) throw invalidToken();

  const user = await findUserById(c.env, token.user_id);
  // Deliberately the same answer for "not an admin" as for "no such account":
  // this endpoint should not confirm anything to a caller who has no business
  // here.
  if (!user?.is_admin) throw forbidden('Administrator access is required.');

  c.set('admin', user);
  await next();
});

/** Everything the admin view renders, in one request. */
admin.get('/state', async (c) => {
  const [accounts, invites] = await Promise.all([listAccounts(c.env), listInvites(c.env)]);
  return c.json({ self: c.get('admin').id, accounts, invites });
});

admin.post('/invites', async (c) => {
  interface MintRequest {
    count?: number;
    note?: string;
  }
  const body = await c.req.json<MintRequest>().catch(() => ({}) as MintRequest);

  const count = Math.trunc(body.count ?? 1);
  if (!Number.isFinite(count) || count < 1 || count > MAX_INVITES_PER_REQUEST) {
    throw badRequest(`count must be between 1 and ${MAX_INVITES_PER_REQUEST}.`);
  }

  const note = body.note?.trim().slice(0, MAX_NOTE_LENGTH) || null;
  const codes = Array.from({ length: count }, generateInviteCode);
  await createInvites(c.env, codes, note, Date.now());

  return c.json({ codes }, 201);
});

admin.delete('/invites/:code', async (c) => {
  if (!(await revokeInvite(c.env, c.req.param('code')))) {
    throw badRequest('That invite code does not exist, or has already been used.');
  }
  return c.body(null, 204);
});

admin.delete('/accounts/:id', async (c) => {
  const id = accountId(c.req.param('id'));

  // Deleting yourself would, on the last remaining admin, leave the service with
  // no way in through the web view at all.
  if (id === c.get('admin').id) throw forbidden('An administrator cannot delete their own account.');

  const user = await findUserById(c.env, id);
  if (!user) throw badRequest('No such account.');

  await deleteAccount(c.env, id);
  return c.body(null, 204);
});

/**
 * Issues a new password for an account and signs it out everywhere. The password
 * is returned exactly once, here: the server keeps only a hash of it.
 */
admin.post('/accounts/:id/password', async (c) => {
  const id = accountId(c.req.param('id'));

  const user = await findUserById(c.env, id);
  if (!user) throw badRequest('No such account.');

  const password = generatePassword();
  await replacePassword(c.env, id, await hashPassword(password));

  return c.json({ password });
});

function accountId(raw: string): string {
  if (!isUuid(raw)) throw badRequest('not a valid uuid');
  return dash(raw);
}
