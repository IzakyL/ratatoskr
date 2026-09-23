import { Hono } from 'hono';
import { bridgeHasJoined, bridgeProfile } from '../lib/bridge';
import { findBridgedById, findProfileById, findValidToken } from '../lib/db';
import { badRequest, forbidden, invalidToken } from '../lib/errors';
import { fullProfile, publicOrigin } from '../lib/profile';
import { dash, isUuid, undash } from '../lib/uuid';
import type { Env } from '../types';

/**
 * A join record proves "this player just asked to join a server with this
 * shared-secret-derived serverId". The Minecraft server then asks hasJoined
 * within a few seconds. 60s is KV's minimum TTL and is plenty.
 */
const JOIN_TTL_SECONDS = 60;

interface JoinRequest {
  accessToken?: string;
  selectedProfile?: string;
  serverId?: string;
}

interface JoinRecord {
  profileId: string;
  name: string;
  ip: string | null;
}

const joinKey = (serverId: string) => `join:${serverId}`;

export const sessionserver = new Hono<{ Bindings: Env }>();

sessionserver.post('/session/minecraft/join', async (c) => {
  const body = await c.req.json<JoinRequest>().catch(() => ({}) as JoinRequest);
  const { accessToken, selectedProfile, serverId } = body;
  if (!accessToken || !selectedProfile || !serverId) {
    throw badRequest('accessToken, selectedProfile and serverId are required');
  }
  if (!isUuid(selectedProfile)) throw badRequest('selectedProfile is not a valid uuid');

  const token = await findValidToken(c.env, accessToken, Date.now());
  if (!token) throw invalidToken();

  // The token must actually be bound to the profile it claims to be joining as.
  if (!token.profile_id || undash(token.profile_id) !== undash(selectedProfile)) {
    throw forbidden('Invalid token.');
  }

  const profile = await findProfileById(c.env, dash(selectedProfile));
  if (!profile) throw forbidden('Invalid token.');

  const record: JoinRecord = {
    profileId: profile.id,
    name: profile.name,
    ip: c.req.header('cf-connecting-ip') ?? null,
  };
  await c.env.KV.put(joinKey(serverId), JSON.stringify(record), {
    expirationTtl: JOIN_TTL_SECONDS,
  });

  return c.body(null, 204);
});

sessionserver.get('/session/minecraft/hasJoined', async (c) => {
  const username = c.req.query('username');
  const serverId = c.req.query('serverId');
  const ip = c.req.query('ip');
  if (!username || !serverId) return c.body(null, 204);

  const raw = await c.env.KV.get(joinKey(serverId));
  if (!raw) {
    // Not one of ours; in bridge mode, perhaps one of an upstream's.
    const bridged = await bridgeHasJoined(c.env, username, serverId, ip);
    return bridged ? c.json(bridged) : c.body(null, 204);
  }

  const record = JSON.parse(raw) as JoinRecord;
  if (record.name.toLowerCase() !== username.toLowerCase()) return c.body(null, 204);
  // `ip` is optional and only sent when the server has prevent-proxy-connections
  // enabled; when it is sent it must match the address the player joined from.
  if (ip && record.ip && ip !== record.ip) return c.body(null, 204);

  const profile = await findProfileById(c.env, record.profileId);
  if (!profile) return c.body(null, 204);

  // hasJoined responses are always signed: this is what the server verifies
  // before it trusts the skin URL we hand it.
  return c.json(
    await fullProfile(c.env, profile, publicOrigin(c.env, c.req.url), true, Date.now()),
  );
});

sessionserver.get('/session/minecraft/profile/:uuid', async (c) => {
  const uuid = c.req.param('uuid');
  if (!isUuid(uuid)) return c.body(null, 204);

  const signed = c.req.query('unsigned') === 'false';

  const profile = await findProfileById(c.env, dash(uuid));
  if (!profile) {
    const bridged = await findBridgedById(c.env, dash(uuid));
    const upstream = bridged && (await bridgeProfile(c.env, bridged, signed));
    return upstream ? c.json(upstream) : c.body(null, 204);
  }

  return c.json(
    await fullProfile(c.env, profile, publicOrigin(c.env, c.req.url), signed, Date.now()),
  );
});
