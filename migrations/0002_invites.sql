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
