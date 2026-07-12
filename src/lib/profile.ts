import { b64encode, signTextureValue } from './crypto';
import { undash } from './uuid';
import type { Env, Profile } from '../types';

export interface ProfileProperty {
  name: string;
  value: string;
  signature?: string;
}

export interface SerializedProfile {
  id: string;
  name: string;
  properties?: ProfileProperty[];
}

/** The origin textures are served from, and that clients must trust. */
export function publicOrigin(env: Env, requestUrl: string): string {
  const configured = env.PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return new URL(requestUrl).origin;
}

/** Minimal form used by /authenticate and the name-lookup API. */
export function minimalProfile(profile: Profile): SerializedProfile {
  return { id: undash(profile.id), name: profile.name };
}

/**
 * Full form used by hasJoined and the profile endpoint. `signed` adds the
 * SHA1withRSA signature that servers verify before trusting the skin URL.
 */
export async function fullProfile(
  env: Env,
  profile: Profile,
  origin: string,
  signed: boolean,
  now: number,
): Promise<SerializedProfile> {
  const textures: Record<string, unknown> = {};

  if (profile.skin_hash) {
    textures.SKIN = {
      url: `${origin}/textures/${profile.skin_hash}`,
      // Mojang only emits metadata for the slim ("Alex") model; a missing
      // metadata block means the classic model.
      ...(profile.skin_model === 'slim' ? { metadata: { model: 'slim' } } : {}),
    };
  }
  if (profile.cape_hash) {
    textures.CAPE = { url: `${origin}/textures/${profile.cape_hash}` };
  }

  const payload = {
    timestamp: now,
    profileId: undash(profile.id),
    profileName: profile.name,
    ...(signed ? { signatureRequired: true } : {}),
    textures,
  };

  const value = b64encode(new TextEncoder().encode(JSON.stringify(payload)));
  const property: ProfileProperty = { name: 'textures', value };
  if (signed) property.signature = await signTextureValue(env.SIGNING_KEY, value);

  return { id: undash(profile.id), name: profile.name, properties: [property] };
}
