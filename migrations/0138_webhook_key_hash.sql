-- #742: form webhook keys are stored as a SHA-256 hash and each key gets a "trust the body"
-- switch.
--
-- token_hash  SHA-256 hex of the key. New keys are stored as a hash only (the key is shown
--             once at creation). SQLite can't hash here, so existing keys move over at run
--             time: the first request with an old key writes its hash and replaces the
--             plaintext `token` with a non-secret placeholder (`token` stays NOT NULL UNIQUE).
-- token_last4 last 4 characters of the key, for display once it is hashed.
-- trust_body  1 = the request body may name the list and tags, an existing contact's fields
--             are updated and the response says added / updated (the old behaviour). New keys
--             default to 0; every key that exists today keeps the old behaviour.
ALTER TABLE webhook_keys ADD COLUMN token_hash TEXT;
ALTER TABLE webhook_keys ADD COLUMN token_last4 TEXT;
ALTER TABLE webhook_keys ADD COLUMN trust_body INTEGER NOT NULL DEFAULT 0;

-- One-time step, for the rows that existed before this migration only. Never re-run this
-- UPDATE by hand: it would switch trust back on for every key created since, including keys
-- an admin made with trust off for a web form.
UPDATE webhook_keys SET trust_body = 1;

-- Keep the last 4 characters of every existing key for display.
UPDATE webhook_keys SET token_last4 = substr(token, -4);

-- A revoked key never authenticates again, so its plaintext can go now.
UPDATE webhook_keys SET token = 'revoked:' || id WHERE revoked_at IS NOT NULL;

CREATE UNIQUE INDEX ux_webhook_keys_token_hash ON webhook_keys(token_hash) WHERE token_hash IS NOT NULL;
