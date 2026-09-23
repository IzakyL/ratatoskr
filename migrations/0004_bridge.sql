-- Bridge mode: players signed in with another Yggdrasil service (Mojang,
-- LittleSkin, ...) whom this service vouched for on their first join.
--
-- The row is what protects a name across services: a name belongs to the first
-- (source, uuid) that joined with it, and hasJoined refuses anyone else who
-- turns up with that name from any service. Deleting a row releases the name.
CREATE TABLE bridged_profiles (
  id         TEXT PRIMARY KEY,              -- the upstream's uuid, dashed
  source     TEXT NOT NULL,                 -- upstream label from BRIDGE_UPSTREAMS
  name       TEXT NOT NULL,
  name_lower TEXT NOT NULL UNIQUE,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);
