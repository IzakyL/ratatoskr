-- Bridge mode's upstreams, managed from the admin view. This replaces the
-- BRIDGE_UPSTREAMS variable, so that adding a service no longer needs a deploy.
--
-- The label is what bridged_profiles.source refers to, which is why it cannot
-- be edited: removing an upstream removes its players with it (see db.ts).
CREATE TABLE bridge_upstreams (
  label      TEXT PRIMARY KEY,
  api_root   TEXT,                           -- NULL for Mojang
  created_at INTEGER NOT NULL
);
