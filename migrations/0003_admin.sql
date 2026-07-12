-- The administrator is an ordinary account with a flag: same login, same token,
-- same character in game. It is created by `npm run setup` (or `npm run
-- create-admin`) rather than by registering, which is why it needs no invite
-- code of its own.
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
