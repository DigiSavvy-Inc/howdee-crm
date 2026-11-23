import { env } from 'cloudflare:test';
import { configureReportHost } from '../src/lib/server/report-url';

// #661: the contact `report_url` guard's host is the Worker var SNAPSHOT_REPORT_HOST, set per
// request by hooks.server.ts. Tests call handlers without the hook, so every test file starts
// with the pool's binding applied. No binding = no host: report_url is an ordinary field.
configureReportHost(env);
