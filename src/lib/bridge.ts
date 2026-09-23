import { claimBridged, findBridgedByName, findProfileById, findProfileByName, listUpstreams } from './db';
import { badRequest } from './errors';
import type { ProfileProperty, SerializedProfile } from './profile';
import { dash, isUuid, undash } from './uuid';
import type { BridgedProfile, Env } from '../types';

/* ------------------------------------------------------------------ *
 * Bridge mode.
 *
 * A Minecraft server points authlib-injector at exactly one service. With
 * upstreams added in the admin view, that service can be this one while players keep
 * signing in wherever they already have an account: when hasJoined finds no
 * join record of ours, the same question is put to each upstream, and the
 * first to recognise the player answers for them.
 *
 * Upstream profiles are passed through untouched, signatures included. They
 * cannot be re-signed with our key without lying about where the skin came
 * from, and a Mojang signature is trusted by every authlib-injector anyway.
 * ------------------------------------------------------------------ */

export interface Upstream {
  /** Stable name, stored against every player this upstream vouched for. */
  label: string;
  /** Base of the session server: `${session}/session/minecraft/hasJoined`. */
  session: string;
  /** The authlib-injector API root, for reading skinDomains; null for Mojang. */
  apiRoot: string | null;
}

const MOJANG: Upstream = {
  label: 'mojang',
  session: 'https://sessionserver.mojang.com',
  apiRoot: null,
};

const LABEL_PATTERN = /^[a-z0-9_-]{1,32}$/;
const UPSTREAM_TIMEOUT_MS = 5000;

/**
 * The upstreams the administrator has added, oldest first. None means bridge
 * mode is off. Read on every request rather than cached, so that a change in the
 * admin view takes effect on the very next join.
 */
export async function upstreams(env: Env): Promise<Upstream[]> {
  return (await listUpstreams(env)).map((row) => toUpstream(row.label, row.api_root));
}

function toUpstream(label: string, apiRoot: string | null): Upstream {
  return apiRoot ? { label, session: `${apiRoot}/sessionserver`, apiRoot } : MOJANG;
}

/**
 * Checks an upstream the administrator wants to add: `mojang` for the official
 * service, or any other label with the API root of an authlib-injector
 * compatible one -- the same address players paste into their launcher. The
 * metadata document is fetched once, so that a typo is caught here rather than
 * by a player who cannot get in.
 */
export async function checkUpstream(label: string, rawApiRoot: string | undefined): Promise<Upstream> {
  if (label === MOJANG.label) {
    if (rawApiRoot) throw badRequest('"mojang" is the official service and takes no address.');
    return MOJANG;
  }
  if (!LABEL_PATTERN.test(label)) {
    throw badRequest('A label is 1-32 characters of a-z, 0-9, _ or -.');
  }

  const apiRoot = (rawApiRoot ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]/.test(apiRoot)) throw badRequest('The address must start with https:// or http://.');

  try {
    const response = await fetch(apiRoot, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    const body = (await response.json()) as { signaturePublickey?: unknown };
    if (typeof body?.signaturePublickey !== 'string') throw new Error('no signaturePublickey');
  } catch {
    throw badRequest(`${apiRoot} does not answer as a Yggdrasil API root.`);
  }
  return toUpstream(label, apiRoot);
}

/**
 * hasJoined, asked of the upstreams. Returns the profile to hand back to the
 * Minecraft server, or null to turn the player away.
 *
 * A name belongs to whoever first joined with it: our own accounts always,
 * otherwise the first (upstream, uuid) this service vouched for. Without that
 * anyone could register "Notch" on some other service and walk in as him.
 */
export async function bridgeHasJoined(
  env: Env,
  username: string,
  serverId: string,
  ip: string | undefined,
): Promise<SerializedProfile | null> {
  const configured = await upstreams(env);
  if (configured.length === 0) return null;

  if (await findProfileByName(env, username)) return null;

  // A known player is only ever asked about at the upstream they came from.
  const bound = await findBridgedByName(env, username);
  const candidates = bound ? configured.filter((u) => u.label === bound.source) : configured;

  // serverId is unique to this one connection, so at most one upstream can
  // recognise it; asking them all at once only saves time.
  const answers = await Promise.all(
    candidates.map((upstream) => askHasJoined(upstream, username, serverId, ip)),
  );
  const index = answers.findIndex(Boolean);
  if (index < 0) return null;
  const upstream = candidates[index]!;
  const profile = answers[index]!;

  const id = dash(profile.id);
  // Should an upstream hand out a uuid that one of our own characters has,
  // the two would be indistinguishable in game.
  if (await findProfileById(env, id)) return null;
  if (!(await claimBridged(env, upstream.label, id, profile.name, Date.now()))) return null;

  return profile;
}

async function askHasJoined(
  upstream: Upstream,
  username: string,
  serverId: string,
  ip: string | undefined,
): Promise<SerializedProfile | null> {
  const url = new URL(`${upstream.session}/session/minecraft/hasJoined`);
  url.searchParams.set('username', username);
  url.searchParams.set('serverId', serverId);
  if (ip) url.searchParams.set('ip', ip);

  const profile = await fetchProfile(upstream, url);
  // An upstream answering for somebody else is not an answer.
  if (!profile || profile.name.toLowerCase() !== username.toLowerCase()) return null;
  return profile;
}

/** The profile endpoint, for a player we already know came from `bridged.source`. */
export async function bridgeProfile(
  env: Env,
  bridged: BridgedProfile,
  signed: boolean,
): Promise<SerializedProfile | null> {
  const upstream = (await upstreams(env)).find((u) => u.label === bridged.source);
  if (!upstream) return null;

  const url = new URL(`${upstream.session}/session/minecraft/profile/${undash(bridged.id)}`);
  if (signed) url.searchParams.set('unsigned', 'false');
  const profile = await fetchProfile(upstream, url);
  return profile && profile.id === undash(bridged.id) ? profile : null;
}

/**
 * Fetches and sanity-checks a profile. Anything unexpected -- an error, a
 * timeout, a malformed body -- counts as "not recognised", so that one upstream
 * being down never locks out players of the others.
 */
async function fetchProfile(upstream: Upstream, url: URL): Promise<SerializedProfile | null> {
  let body: unknown;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    if (response.status !== 200) return null;
    body = await response.json();
  } catch (error) {
    console.warn(`bridge: ${upstream.label} did not answer: ${error}`);
    return null;
  }

  const { id, name, properties } = (body ?? {}) as Record<string, unknown>;
  if (typeof id !== 'string' || !isUuid(id) || typeof name !== 'string' || !name) return null;

  const kept = Array.isArray(properties) ? properties.filter(isProperty) : [];
  return { id: undash(id), name, properties: kept };
}

function isProperty(value: unknown): value is ProfileProperty {
  const { name, value: content, signature } = (value ?? {}) as Record<string, unknown>;
  return (
    typeof name === 'string' &&
    typeof content === 'string' &&
    (signature === undefined || typeof signature === 'string')
  );
}

/* ---------------- skin domains ---------------- */

const SKIN_DOMAINS_TTL_MS = 60 * 60 * 1000;
// A failed read is retried sooner, so an upstream's brief outage does not pin
// the fallback in place for an hour.
const SKIN_DOMAINS_RETRY_MS = 5 * 60 * 1000;
const skinDomainCache = new Map<string, { domains: string[]; expires: number }>();

/**
 * Hosts our own clients must accept textures from, so that bridged players'
 * skins are not blocked by authlib-injector's whitelist. Read from each
 * upstream's metadata; when that fails, its own host is the best guess.
 */
export async function upstreamSkinDomains(env: Env): Promise<string[]> {
  const lists = await Promise.all((await upstreams(env)).map(skinDomainsOf));
  return [...new Set(lists.flat())];
}

async function skinDomainsOf(upstream: Upstream): Promise<string[]> {
  // Mojang's textures.minecraft.net is on authlib's built-in whitelist.
  if (!upstream.apiRoot) return [];

  const cached = skinDomainCache.get(upstream.apiRoot);
  if (cached && cached.expires > Date.now()) return cached.domains;

  let domains = [new URL(upstream.apiRoot).hostname];
  let ttl = SKIN_DOMAINS_RETRY_MS;
  try {
    const response = await fetch(upstream.apiRoot, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    const { skinDomains } = (await response.json()) as { skinDomains?: unknown };
    if (Array.isArray(skinDomains)) {
      domains = skinDomains.filter((domain): domain is string => typeof domain === 'string');
      ttl = SKIN_DOMAINS_TTL_MS;
    }
  } catch (error) {
    console.warn(`bridge: could not read metadata of ${upstream.label}: ${error}`);
  }

  skinDomainCache.set(upstream.apiRoot, { domains, expires: Date.now() + ttl });
  return domains;
}
