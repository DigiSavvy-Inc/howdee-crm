import { applyD1Migrations, env } from 'cloudflare:test';

// Bring the test D1 up to the current schema before any test runs.
await applyD1Migrations((env as any).DB, (env as any).TEST_MIGRATIONS);
