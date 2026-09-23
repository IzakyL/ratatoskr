export interface Env {
  DB: D1Database;
  KV: KVNamespace;

  SERVER_NAME: string;
  PUBLIC_URL: string;
  SKIN_DOMAINS: string;
  BRIDGE_UPSTREAMS: string;

  SIGNING_KEY: string;
}

export interface User {
  id: string;
  email: string;
  email_lower: string;
  password_hash: string;
  created_at: number;
  is_admin: number; // SQLite has no boolean; 0 or 1
}

/** A user with their character folded in, for the admin listing. */
export interface Account {
  id: string;
  email: string;
  created_at: number;
  is_admin: number;
  profile_id: string | null;
  profile_name: string | null;
}

export interface Profile {
  id: string;
  user_id: string;
  name: string;
  name_lower: string;
  skin_hash: string | null;
  skin_model: 'default' | 'slim';
  cape_hash: string | null;
  created_at: number;
}

/** A player from another Yggdrasil service; see migrations/0004_bridge.sql. */
export interface BridgedProfile {
  id: string;
  source: string;
  name: string;
  name_lower: string;
  first_seen: number;
  last_seen: number;
}

export interface Invite {
  code: string;
  note: string | null;
  created_at: number;
  used_at: number | null;
  used_by: string | null;
}

export interface Token {
  access_token: string;
  client_token: string;
  user_id: string;
  profile_id: string | null;
  issued_at: number;
  expires_at: number;
}
