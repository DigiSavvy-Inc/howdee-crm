#!/usr/bin/env node
// dscrm (#348): a tiny CLI over the Data API (/api/v1) for shell and scripting use. No deps;
// Node 18+ (global fetch). Env: DSCRM_URL (app origin) + DSCRM_KEY (Data API key).
// Pure parts (arguments, requests, table output) live in ./dscrm-lib.mjs.
import { readFile } from 'node:fs/promises';
import { USAGE, draftBody, errorMessage, formatTable, parseArgs, planRequest } from './dscrm-lib.mjs';

async function main() {
	const { positional, flags } = parseArgs(process.argv.slice(2));
	if (flags.help || positional.length === 0) {
		console.log(USAGE);
		return 0;
	}
	const plan = planRequest(positional, flags);

	const base = (process.env.DSCRM_URL ?? '').replace(/\/+$/, '');
	const key = process.env.DSCRM_KEY ?? '';
	if (!base) throw new Error('Set DSCRM_URL to the app origin, e.g. https://crm.example.com');
	if (!key) throw new Error('Set DSCRM_KEY to a Data API key (Settings → API).');

	let body = plan.body;
	if (plan.readFile) {
		const text = await readFile(plan.readFile, 'utf8');
		if (plan.markdown) body = draftBody(text, typeof flags.subject === 'string' ? flags.subject : undefined);
		else {
			try {
				body = JSON.parse(text);
			} catch (e) {
				throw new Error(`${plan.readFile} is not valid JSON: ${e instanceof Error ? e.message : e}`);
			}
		}
	}

	const res = await fetch(base + plan.path, {
		method: plan.method,
		headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const text = await res.text();
	let parsed = null;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		parsed = { error: text.slice(0, 300) };
	}
	if (!res.ok) {
		console.error(errorMessage(res.status, parsed));
		return 1;
	}
	const data = parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
	console.log(flags.table ? formatTable(data) : JSON.stringify(parsed, null, 2));
	return 0;
}

main().then(
	(code) => process.exit(code),
	(e) => {
		console.error(e instanceof Error ? e.message : String(e));
		process.exit(1);
	}
);
