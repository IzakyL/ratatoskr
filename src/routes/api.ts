import { Hono } from 'hono';
import { sha256Hex } from '../lib/crypto';
import { findBridgedByNames, findProfileById, findProfilesByNames, findValidToken } from '../lib/db';
import { badRequest, forbidden, invalidToken } from '../lib/errors';
import { isValidCapeSize, isValidSkinSize, readPngSize } from '../lib/png';
import { minimalProfile } from '../lib/profile';
import { dash, isUuid, undash } from '../lib/uuid';
import type { Env } from '../types';

const MAX_TEXTURE_BYTES = 512 * 1024;
const MAX_NAME_LOOKUP = 10;

export const textureKey = (hash: string) => `tex:${hash}`;

export const api = new Hono<{ Bindings: Env }>();

/** Batch name -> uuid lookup. Servers use this for whitelists and bans. */
api.post('/profiles/minecraft', async (c) => {
  const names = await c.req.json<unknown>().catch(() => null);
  if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) {
    throw badRequest('expected a JSON array of names');
  }
  if (names.length > MAX_NAME_LOOKUP) {
    throw badRequest(`at most ${MAX_NAME_LOOKUP} names per request`);
  }

  // Bridged players are included so that whitelists and bans work for them
  // too; only those who have joined at least once are known here.
  const [profiles, bridged] = await Promise.all([
    findProfilesByNames(c.env, names as string[]),
    findBridgedByNames(c.env, names as string[]),
  ]);
  return c.json([
    ...profiles.map(minimalProfile),
    ...bridged.map((player) => ({ id: undash(player.id), name: player.name })),
  ]);
});

/**
 * authlib-injector's texture upload extension. The client (or our own web UI)
 * sends the PNG with the player's access token; we content-address it into KV
 * and point the profile at the hash.
 */
api.put('/user/profile/:uuid/:type', async (c) => {
  const { profile } = await authorizeProfile(c.env, c.req.header('authorization'), c.req.param('uuid'));
  const type = textureType(c.req.param('type'));

  const form = await c.req.formData().catch(() => null);
  if (!form) throw badRequest('expected multipart/form-data');

  const file = form.get('file');
  if (!(file instanceof File)) throw badRequest('missing file field');
  if (file.size > MAX_TEXTURE_BYTES) throw badRequest('texture is larger than 512 KiB');

  const bytes = new Uint8Array(await file.arrayBuffer());
  const size = readPngSize(bytes);
  if (!size) throw badRequest('texture must be a PNG');

  if (type === 'skin' && !isValidSkinSize(size)) {
    throw badRequest(`invalid skin size ${size.width}x${size.height}`);
  }
  if (type === 'cape' && !isValidCapeSize(size)) {
    throw badRequest(`invalid cape size ${size.width}x${size.height}`);
  }

  const hash = await sha256Hex(bytes);
  await c.env.KV.put(textureKey(hash), bytes, {
    metadata: { width: size.width, height: size.height },
  });

  if (type === 'skin') {
    const model = form.get('model') === 'slim' ? 'slim' : 'default';
    await c.env.DB.prepare('UPDATE profiles SET skin_hash = ?, skin_model = ? WHERE id = ?')
      .bind(hash, model, profile)
      .run();
  } else {
    await c.env.DB.prepare('UPDATE profiles SET cape_hash = ? WHERE id = ?').bind(hash, profile).run();
  }

  return c.body(null, 204);
});

api.delete('/user/profile/:uuid/:type', async (c) => {
  const { profile } = await authorizeProfile(c.env, c.req.header('authorization'), c.req.param('uuid'));
  const type = textureType(c.req.param('type'));

  const column = type === 'skin' ? 'skin_hash' : 'cape_hash';
  await c.env.DB.prepare(`UPDATE profiles SET ${column} = NULL WHERE id = ?`).bind(profile).run();

  // The blob itself stays in KV: it is content-addressed, so another profile
  // may well be pointing at the same bytes.
  return c.body(null, 204);
});

function textureType(raw: string): 'skin' | 'cape' {
  const type = raw.toLowerCase();
  if (type !== 'skin' && type !== 'cape') throw badRequest(`unknown texture type: ${raw}`);
  return type;
}

/** Verifies the bearer token owns the profile named in the path. */
async function authorizeProfile(
  env: Env,
  authorization: string | undefined,
  uuid: string,
): Promise<{ profile: string }> {
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  if (!match) throw invalidToken();

  const token = await findValidToken(env, match[1]!, Date.now());
  if (!token) throw invalidToken();

  if (!isUuid(uuid)) throw badRequest('not a valid uuid');
  const profile = await findProfileById(env, dash(uuid));
  if (!profile || profile.user_id !== token.user_id) {
    throw forbidden('You do not own this profile.');
  }

  return { profile: profile.id };
}
