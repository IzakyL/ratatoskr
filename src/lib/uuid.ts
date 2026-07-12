// Yggdrasil serialises UUIDs without dashes on the wire, but they are much
// easier to read (and to paste into SQL) with them. Dashed is the storage form.

export function randomUuid(): string {
  return crypto.randomUUID();
}

export function undash(uuid: string): string {
  return uuid.replace(/-/g, '').toLowerCase();
}

export function dash(uuid: string): string {
  const hex = undash(uuid);
  if (hex.length !== 32) throw new Error(`not a uuid: ${uuid}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{32}$/i.test(undash(value)) && /^[0-9a-f-]+$/i.test(value);
}

/** Random opaque token, used for accessToken / clientToken. */
export function randomToken(): string {
  return undash(crypto.randomUUID()) + undash(crypto.randomUUID());
}
