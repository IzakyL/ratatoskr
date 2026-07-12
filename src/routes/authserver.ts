import { Hono } from 'hono';
import { verifyPassword } from '../lib/crypto';
import {
  createToken,
  deleteToken,
  deleteTokensForUser,
  findProfilesByUser,
  findUserByEmail,
  findUserByProfileName,
  findValidToken,
} from '../lib/db';
import { badRequest, invalidCredentials, invalidToken } from '../lib/errors';
import { minimalProfile } from '../lib/profile';
import { randomToken, undash } from '../lib/uuid';
import type { Env, Profile, User } from '../types';

interface AuthRequest {
  username?: string;
  password?: string;
  clientToken?: string;
  requestUser?: boolean;
  agent?: { name?: string; version?: number };
}

interface RefreshRequest {
  accessToken?: string;
  clientToken?: string;
  requestUser?: boolean;
  selectedProfile?: { id?: string; name?: string };
}

const serializeUser = (user: User) => ({ id: undash(user.id), properties: [] });

export const authserver = new Hono<{ Bindings: Env }>();

authserver.post('/authenticate', async (c) => {
  const body = await c.req.json<AuthRequest>().catch(() => ({}) as AuthRequest);
  const { username, password } = body;
  if (!username || !password) throw badRequest('username and password are required');

  // The login identity is the email, but Yggdrasil also allows the character
  // name (authlib-injector advertises this as feature.non_email_login).
  const user =
    (await findUserByEmail(c.env, username)) ?? (await findUserByProfileName(c.env, username));
  if (!user) throw invalidCredentials();
  if (!(await verifyPassword(password, user.password_hash))) throw invalidCredentials();

  const profiles = await findProfilesByUser(c.env, user.id);
  // One profile per account, so it is always the selected one. With zero
  // profiles the client still logs in, it just has no character to play as.
  const selected: Profile | undefined = profiles[0];

  const clientToken = body.clientToken ?? randomToken();
  const accessToken = randomToken();
  await createToken(c.env, user.id, clientToken, selected?.id ?? null, accessToken, Date.now());

  return c.json({
    accessToken,
    clientToken,
    availableProfiles: profiles.map(minimalProfile),
    ...(selected ? { selectedProfile: minimalProfile(selected) } : {}),
    ...(body.requestUser ? { user: serializeUser(user) } : {}),
  });
});

authserver.post('/refresh', async (c) => {
  const body = await c.req.json<RefreshRequest>().catch(() => ({}) as RefreshRequest);
  if (!body.accessToken) throw badRequest('accessToken is required');

  const token = await findValidToken(c.env, body.accessToken, Date.now());
  if (!token) throw invalidToken();
  if (body.clientToken && body.clientToken !== token.client_token) throw invalidToken();

  const profiles = await findProfilesByUser(c.env, token.user_id);

  let profileId = token.profile_id;
  if (body.selectedProfile) {
    // Selecting a profile is only legal when the token has none bound yet.
    if (token.profile_id) {
      throw badRequest('Access token already has a profile assigned.');
    }
    const wanted = profiles.find((p) => undash(p.id) === undash(body.selectedProfile!.id ?? ''));
    if (!wanted) throw badRequest('Invalid profile.');
    profileId = wanted.id;
  }

  // Rotate: the old access token dies with the refresh, as the spec requires.
  const accessToken = randomToken();
  await deleteToken(c.env, token.access_token);
  await createToken(
    c.env,
    token.user_id,
    token.client_token,
    profileId,
    accessToken,
    Date.now(),
  );

  const selected = profiles.find((p) => p.id === profileId);
  return c.json({
    accessToken,
    clientToken: token.client_token,
    ...(selected ? { selectedProfile: minimalProfile(selected) } : {}),
    ...(body.requestUser
      ? { user: { id: undash(token.user_id), properties: [] } }
      : {}),
  });
});

authserver.post('/validate', async (c) => {
  const body = await c.req.json<RefreshRequest>().catch(() => ({}) as RefreshRequest);
  if (!body.accessToken) throw invalidToken();

  const token = await findValidToken(c.env, body.accessToken, Date.now());
  if (!token) throw invalidToken();
  if (body.clientToken && body.clientToken !== token.client_token) throw invalidToken();

  return c.body(null, 204);
});

authserver.post('/invalidate', async (c) => {
  const body = await c.req.json<RefreshRequest>().catch(() => ({}) as RefreshRequest);
  if (body.accessToken) await deleteToken(c.env, body.accessToken);
  // Always 204: telling a caller whether the token existed leaks information.
  return c.body(null, 204);
});

authserver.post('/signout', async (c) => {
  const body = await c.req.json<AuthRequest>().catch(() => ({}) as AuthRequest);
  const { username, password } = body;
  if (!username || !password) throw badRequest('username and password are required');

  const user =
    (await findUserByEmail(c.env, username)) ?? (await findUserByProfileName(c.env, username));
  if (!user) throw invalidCredentials();
  if (!(await verifyPassword(password, user.password_hash))) throw invalidCredentials();

  await deleteTokensForUser(c.env, user.id);
  return c.body(null, 204);
});
