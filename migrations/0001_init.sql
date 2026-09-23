-- Users are the login identity; profiles are the in-game characters.
-- This service keeps it one profile per user, which is what a Yggdrasil
-- client expects by default, but the schema leaves room for more.
CREATE TABLE users (
  id            TEXT PRIMARY KEY,           -- uuid, dashed
  email         TEXT NOT NULL,
  email_lower   TEXT NOT NULL UNIQUE,       -- lookup key, case-insensitive
  password_hash TEXT NOT NULL,              -- <scheme>$<salt>$<hash>; see lib/crypto.ts
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

-- The administrator is an ordinary account with a flag: same login, same token,
-- same character in game. It is created by `npm run setup` (or `npm run
-- create-admin`) rather than by registering, which is why it needs no invite
-- code of its own.

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

-- Invite codes are single use: one code, one account, spent on redemption.
--
-- The code is stored in the clear deliberately. An operator has to be able to
-- read an unused code back out in order to hand it to somebody
-- (`npm run invite -- --list`), which a hash would prevent; and a code is only
-- ever worth one registration, against a database an attacker would have to
-- already hold to read it.
CREATE TABLE invites (
  code       TEXT PRIMARY KEY,
  note       TEXT,                  -- who it was meant for; the operator's own reminder
  created_at INTEGER NOT NULL,
  used_at    INTEGER,               -- NULL while the code is still spendable
  used_by    TEXT                   -- users(id); no foreign key, see below
);

-- used_by carries no REFERENCES clause on purpose: the code is claimed before
-- the user row it will belong to exists, so a foreign key would reject the very
-- write that claims it. The reference is informational.

CREATE INDEX invites_used_at ON invites(used_at);

-- Bridge mode's upstreams, managed from the admin view; none means bridge
-- mode is off.
--
-- The label is what bridged_profiles.source refers to, which is why it cannot
-- be edited: removing an upstream removes its players with it (see db.ts).
CREATE TABLE bridge_upstreams (
  label      TEXT PRIMARY KEY,
  api_root   TEXT,                           -- NULL for Mojang
  created_at INTEGER NOT NULL
);

-- Bridge mode: players signed in with another Yggdrasil service (Mojang,
-- LittleSkin, ...) whom this service vouched for on their first join.
--
-- The row is what protects a name across services: a name belongs to the first
-- (source, uuid) that joined with it, and hasJoined refuses anyone else who
-- turns up with that name from any service. Deleting a row releases the name.
CREATE TABLE bridged_profiles (
  id         TEXT PRIMARY KEY,              -- the upstream's uuid, dashed
  source     TEXT NOT NULL,                 -- bridge_upstreams.label
  name       TEXT NOT NULL,
  name_lower TEXT NOT NULL UNIQUE,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);
