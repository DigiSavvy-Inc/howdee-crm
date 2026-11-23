import { env } from 'cloudflare:test';

// #606: migrations no longer seed an admin (a fresh install creates one at /setup). Many suites
// were written against the old seed, so every test file starts with the same row as an explicit
// fixture: id 1, GitHub login 'ourco-admin', admin. tests/setup-606.test.ts removes it to test the
// zero-user path.
await (env as any).DB.prepare(`INSERT OR IGNORE INTO users (id, github_login, role) VALUES (1, 'ourco-admin', 'admin')`).run();
