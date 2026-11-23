# Backups and restore (#308)

All CRM data lives in one D1 database (`postmark-marketing`). There are two ways back:

| | D1 Time Travel | Nightly R2 backups |
| --- | --- | --- |
| What | Cloudflare's point-in-time restore of the whole database | Our own export of every table to R2 |
| Window | the last 30 days, to the minute | the newest 14 backups + the newest 8 Sunday backups |
| Granularity | whole database, in place | one table, a few tables, or everything, into any D1 |
| Secrets | everything | left out (see below) |
| Use it for | "undo the last hour" — a bad bulk action, a bad deploy | a copy that is not inside D1, a single table, a fresh database |

## What the nightly backup writes

The heartbeat tick (`runBackupTick`, `src/lib/server/backups.ts`) starts one run per day once it is
03:00 or later in Settings → Timezone. Settings → Backups → **Back up now** starts one at any time.
Each table is written to the `MEDIA` R2 bucket (`postmark-marketing-media`):

```
backups/2026-10-17/contacts.ndjson.gz      one JSON object per line, gzipped
backups/2026-10-17/events.ndjson.gz        a table over 50,000 rows continues in
backups/2026-10-17/events.2.ndjson.gz      events.2, events.3, …
backups/2026-10-17/manifest.json           written last — a folder without it is unfinished
```

`manifest.json` holds the row count, size and file list of every table, the schema version (the
latest applied migration, e.g. `0077_ai_assistant.sql`), the duration and the exclusions.

Rows are read 5,000 per query (fewer for tables with large text columns). A big database is spread
over several ticks — the cursor is `app_state.backup_run`. A failed step retries on the next tick, up
to 3 times. After a run, folders outside the retention set are deleted. Settings → Backups shows a
warning when the last success is more than 36 hours old.

### Not in the backup

- `integration_secrets` (sealed Timing / GitHub / Anthropic tokens): set them again in Settings.
- `api_keys.token_hash`: restored as a placeholder that matches no key. Rotate the keys in Settings → API.
- `webhook_keys.token`: restored as a placeholder. Rotate each key in Settings → Webhooks and paste the
  new URL into the form tool.
- `mail_accounts.refresh_blob`: restored as a placeholder. Disconnect and reconnect Gmail in Settings → Mail.
- `users.password_hash`: restored as NULL. Users sign in with GitHub or get a new password from an admin.
- `app_state.luma_webhook_secret`: paste the Luma signing secret into Settings again.
- `d1_migrations`: recreated by `wrangler d1 migrations apply`.
- Sessions: they are signed cookies and were never in D1. Everyone signs in again.

## Getting the files

- **Settings → Backups** → a backup's **Tables** → download each file (admins only). The downloads are
  named `backup-<date>-<file>`; the restore script accepts both names.
- Or let the restore script fetch them: `--date 2026-10-17 --bucket postmark-marketing-media` runs
  `wrangler r2 object get … --remote` for the manifest and every file it needs.

Keep the folder **outside the repo**: it holds contact data.

## Restore everything into a fresh D1

```sh
# 1. A new, empty database with the current schema.
npx wrangler d1 create postmark-restore
npx wrangler d1 migrations apply postmark-restore --remote

# 2. Load the backup (empties every table first, then inserts every row).
node scripts/restore-backup.mjs \
  --date 2026-10-17 --bucket postmark-marketing-media \
  --dir ~/restores/2026-10-17 \
  --db postmark-restore --remote

# 3. Spot-check.
npx wrangler d1 execute postmark-restore --remote --command "SELECT COUNT(*) FROM contacts"
```

The schema must match the backup's `schema_version`. If the backup is older than the code, check out
the commit with that migration as its latest, apply migrations from there, restore, then apply the
rest. The script compares every table's row count with the manifest before it writes the SQL.

To make the restored database live, point the `DB` binding's `database_id` in `wrangler.jsonc` at it
and deploy (`npm run deploy`) — or copy tables back into the live database as below.

## Restore one table (or a few)

```sh
node scripts/restore-backup.mjs --dir ~/restores/2026-10-17 \
  --db postmark-marketing --remote \
  --table contacts --table list_members
```

With `--table`, the default mode is **`missing`**: `INSERT OR IGNORE`, so rows that are still there
are left alone and only rows that are gone come back (e.g. contacts deleted by mistake, with their
list memberships). `--mode replace` empties the selected tables first — **but** `ON DELETE CASCADE`
also empties child tables you did not select (deleting `contacts` deletes `list_members`,
`automation_enrollments`, `pipeline_cards`, …), so replace a subset only in a scratch database.

Safer for anything large: restore everything into a fresh database (above), then compare and copy
the rows you need.

Other options: `--local` (local dev D1), `--out <file>` (where the SQL goes, default
`<dir>/restore.sql`), `--sql-only` (write the SQL, don't run wrangler). The SQL starts with
`PRAGMA defer_foreign_keys = true`, inserts in the manifest's table order, and stays under D1's
statement size limit (very long values are staged through a scratch table `_restore_buf`, dropped at
the end).

## D1 Time Travel (fast rollback)

Time Travel restores the **whole** database **in place** to a minute in the last 30 days. Everything
after that point is lost, including sends, webhooks and replies recorded since.

```sh
# Where would we land? (bookmark for a time; times are UTC unless given with an offset)
npx wrangler d1 time-travel info postmark-marketing --timestamp=2026-10-17T14:05:00Z

# Roll back. Prints a bookmark for the state just before the restore, so it can be undone.
npx wrangler d1 time-travel restore postmark-marketing --timestamp=2026-10-17T14:05:00Z

# Undo the rollback.
npx wrangler d1 time-travel restore postmark-marketing --bookmark=<bookmark printed above>
```

Pause the heartbeat Worker's cron first if automations could send in between, and re-check
`d1_migrations`: rolling back past a migration also rolls back its schema, so the next
`npm run deploy` re-applies it.
