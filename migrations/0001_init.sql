-- Users are the login identity; profiles are the in-game characters.
-- This service keeps it one profile per user, which is what a Yggdrasil
-- client expects by default, but the schema leaves room for more.
CREATE TABLE users (
  id            TEXT PRIMARY KEY,           -- uuid, dashed
  email         TEXT NOT NULL,
  email_lower   TEXT NOT NULL UNIQUE,       -- lookup key, case-insensitive
  password_hash TEXT NOT NULL,              -- <scheme>$<salt>$<hash>; see lib/crypto.ts
  created_at    INTEGER NOT NULL
);

CREATE TABLE profiles (
  id         TEXT PRIMARY KEY,              -- uuid, dashed
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  name_lower TEXT NOT NULL UNIQUE,          -- Minecraft names are case-insensitive
  skin_hash  TEXT,                          -- sha256 of the PNG in KV, or NULL
  skin_model TEXT NOT NULL DEFAULT 'default', -- 'default' | 'slim'
  cape_hash  TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX profiles_user_id ON profiles(user_id);

CREATE TABLE tokens (
  access_token TEXT PRIMARY KEY,
  client_token TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id   TEXT REFERENCES profiles(id) ON DELETE CASCADE, -- bound profile, may be NULL
  issued_at    INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE INDEX tokens_user_id ON tokens(user_id);
CREATE INDEX tokens_expires_at ON tokens(expires_at);
