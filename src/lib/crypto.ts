const encoder = new TextEncoder();

/* ------------------------------------------------------------------ *
 * Passwords.
 *
 * Passwords are generated here, never chosen by the user, and carry ~100
 * bits of entropy. That is the entire reason a plain salted SHA-256 is
 * enough: a slow KDF exists to make guessing expensive, and there is
 * nothing here worth guessing -- brute-forcing a 2^100 space stays out of
 * reach however fast the hash is.
 *
 * INVARIANT: nothing may ever write a user-chosen password through
 * hashPassword. The moment a weak password can reach this function, the
 * argument above collapses and a real KDF (PBKDF2, 600k rounds) has to come
 * back. The stored format is scheme-tagged so both can coexist if that day
 * comes.
 * ------------------------------------------------------------------ */

// Crockford's base32 alphabet: no i/l/o/u, so nothing is misread when a
// player copies their password out of a chat message by hand.
const PASSWORD_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const PASSWORD_CHARS = 20; // 20 * log2(32) = 100 bits

export function generatePassword(): string {
  return groupedBase32(PASSWORD_CHARS);
}

/**
 * 16 characters, 80 bits. An invite code buys exactly one registration, so it
 * does not need a password's margin -- but it does need to survive being read
 * aloud, hence the same alphabet. Kept in step with scripts/invite.mjs.
 */
export function generateInviteCode(): string {
  return groupedBase32(16);
}

function groupedBase32(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  // 256 is a multiple of 32, so this modulo is unbiased.
  const value = [...bytes].map((byte) => PASSWORD_ALPHABET[byte % 32]).join('');
  return value.match(/.{4}/g)!.join('-');
}

export function b64encode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function b64decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Salted, so a leaked table cannot be attacked once for every account at a time. */
async function saltedHash(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const input = new Uint8Array(salt.length + password.length * 4);
  input.set(salt);
  const { written } = encoder.encodeInto(password, input.subarray(salt.length));
  const digest = await crypto.subtle.digest('SHA-256', input.subarray(0, salt.length + written));
  return new Uint8Array(digest);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await saltedHash(password, salt);
  return `sha256$${b64encode(salt)}$${b64encode(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltRaw, hashRaw] = stored.split('$');
  if (scheme !== 'sha256' || !saltRaw || !hashRaw) return false;

  const actual = await saltedHash(password, b64decode(saltRaw));
  return timingSafeEqual(b64decode(hashRaw), actual);
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/* ------------------------------------------------------------------ *
 * Texture signatures: Mojang signs the base64 texture property with
 * SHA1withRSA, and authlib-injector verifies it against the public key
 * advertised in our metadata. SHA-1 is a protocol constant here, not a
 * choice -- clients will reject anything else.
 * ------------------------------------------------------------------ */

const ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' } as const;

interface SigningKeys {
  privateKey: CryptoKey;
  publicKeyPem: string;
}

// One import per isolate; re-importing on every request costs real CPU time.
const keyCache = new Map<string, Promise<SigningKeys>>();

export function loadSigningKeys(pem: string): Promise<SigningKeys> {
  let cached = keyCache.get(pem);
  if (!cached) {
    cached = importSigningKeys(pem);
    keyCache.set(pem, cached);
  }
  return cached;
}

async function importSigningKeys(pem: string): Promise<SigningKeys> {
  const pkcs8 = decodePem(pem, 'PRIVATE KEY');
  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8 as BufferSource, ALGORITHM, true, [
    'sign',
  ]);

  // WebCrypto has no "derive public from private", but a JWK round-trip does
  // the job: drop the private components and re-import what is left.
  const jwk = (await crypto.subtle.exportKey('jwk', privateKey)) as JsonWebKey;
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS1', ext: true },
    ALGORITHM,
    true,
    ['verify'],
  );
  const spki = (await crypto.subtle.exportKey('spki', publicKey)) as ArrayBuffer;

  return { privateKey, publicKeyPem: encodePem(new Uint8Array(spki), 'PUBLIC KEY') };
}

export async function signTextureValue(pem: string, value: string): Promise<string> {
  const { privateKey } = await loadSigningKeys(pem);
  const signature = await crypto.subtle.sign(ALGORITHM.name, privateKey, encoder.encode(value));
  return b64encode(signature);
}

export async function publicKeyPem(pem: string): Promise<string> {
  return (await loadSigningKeys(pem)).publicKeyPem;
}

function decodePem(pem: string, label: string): Uint8Array {
  const body = pem
    .replace(new RegExp(`-----(BEGIN|END) ${label}-----`, 'g'), '')
    .replace(/\s+/g, '');
  if (!body) throw new Error(`PEM is missing a ${label} block`);
  return b64decode(body);
}

function encodePem(der: Uint8Array, label: string): string {
  const body = b64encode(der).match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** Hex SHA-256, used to address textures in KV. */
export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
