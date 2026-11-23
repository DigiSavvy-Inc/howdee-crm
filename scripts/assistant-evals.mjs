#!/usr/bin/env node
// Assistant eval runner (#391). Runs the golden cases in evals/assistant/*.json against the
// real model (or replays recordings with --replay), grades them, and writes
// evals/results/<timestamp>.json (full, gitignored) + .md (summary).
//
// Each case runs in workerd on its own Miniflare-bound D1 (evals/harness/, started through
// evals/vitest.config.ts): --concurrency N starts N shard processes, each with its own DB.
// The Anthropic key: ANTHROPIC_API_KEY from the environment, else from .dev.vars. Never printed.
// Docs: docs/assistant-evals.md.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	DEFAULT_EFFORT,
	DEFAULT_MODEL,
	DEFAULT_TIMEOUT_MS,
	JUDGE_MODEL,
	caseProblems,
	collectCases,
	diffRuns,
	filterCases,
	gradeRun,
	judgePrompt,
	makeRecording,
	markdownReport,
	parseDevVars,
	parseJudgeReply,
	parseResultLines,
	parseRunnerArgs,
	shard,
	stamp,
	summarize
} from './assistant-evals-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CASES_DIR = path.join(ROOT, 'evals/assistant');
const RECORDINGS_DIR = path.join(ROOT, 'evals/recordings');

const USAGE = `assistant-evals — run the assistant's golden cases

Usage: node scripts/assistant-evals.mjs [flags]

  --model ID          assistant model (default ${DEFAULT_MODEL}, the app default)
  --effort LEVEL      low | medium | high | max (default ${DEFAULT_EFFORT})
  --filter TERMS      comma list: id/category substrings or /regex/
  --repeat N          run each case N times (flakiness)
  --concurrency N     parallel shards, each with its own D1 (default 4)
  --timeout MS        per-case timeout (default ${DEFAULT_TIMEOUT_MS})
  --judge-model ID    llm_judge model (default ${JUDGE_MODEL}, pinned)
  --no-judge          skip llm_judge graders
  --record            refresh evals/recordings/ for ci cases that pass their tool_calls graders
  --replay            no network: play the recordings back (ci cases only)
  --ci-only           only the cases marked "ci"
  --out DIR           results directory (default evals/results)
  --no-transcripts    leave transcripts out of the Markdown summary`;

/** @param {string} file */
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

function loadCases() {
	/** @type {Record<string, any>} */
	const files = {};
	for (const f of readdirSync(CASES_DIR).filter((x) => x.endsWith('.json'))) files[f] = readJson(path.join(CASES_DIR, f));
	return collectCases(files);
}

function apiKey() {
	if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
	const file = path.join(ROOT, '.dev.vars');
	return existsSync(file) ? (parseDevVars(readFileSync(file, 'utf8')).ANTHROPIC_API_KEY ?? '') : '';
}

/** @param {string} id */
const recordingPath = (id) => path.join(RECORDINGS_DIR, `${id}.json`);

/**
 * One shard = one vitest process on evals/vitest.config.ts.
 * @param {object} job
 * @param {string} key
 * @param {string} dir
 * @param {number} i
 * @returns {Promise<any[]>}
 */
function runShard(job, key, dir, i) {
	const jobFile = path.join(dir, `job-${i}.json`);
	const outFile = path.join(dir, `out-${i}.ndjson`);
	writeFileSync(jobFile, JSON.stringify(job));
	writeFileSync(outFile, '');
	return new Promise((resolve) => {
		const child = spawn('npx', ['vitest', 'run', '--config', 'evals/vitest.config.ts', '--reporter=dot'], {
			cwd: ROOT,
			env: { ...process.env, EVAL_JOB_FILE: jobFile, EVAL_OUT_FILE: outFile, EVAL_ANTHROPIC_KEY: key },
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let output = '';
		child.stdout.on('data', (d) => (output += d));
		child.stderr.on('data', (d) => (output += d));
		child.on('close', (code) => {
			let lines = parseResultLines(readFileSync(outFile, 'utf8'));
			if (!lines.length) lines = parseResultLines(output); // onConsoleLog didn't run: read stdout
			if (code !== 0 && !lines.length) process.stderr.write(`shard ${i} failed:\n${output.slice(-4000).split(key || '\u0000').join('[key]')}\n`);
			resolve(lines);
		});
	});
}

/**
 * @param {string} model
 * @param {string} key
 * @returns {import('./assistant-evals-lib.mjs').Judge}
 */
function makeJudge(model, key) {
	return async ({ rubric, run, evalCase }) => {
		const res = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
			body: JSON.stringify({ model, max_tokens: 400, messages: [{ role: 'user', content: judgePrompt(rubric, run, evalCase) }] })
		});
		if (!res.ok) return { pass: false, reason: `judge HTTP ${res.status}` };
		const body = /** @type {{ content?: { type: string, text?: string }[] }} */ (await res.json());
		return parseJudgeReply((body.content ?? []).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join(''));
	};
}

/** @param {string} dir */
function previousEntries(dir) {
	if (!existsSync(dir)) return null;
	const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
	const last = files.at(-1);
	return last ? (readJson(path.join(dir, last)).entries ?? null) : null;
}

async function main() {
	const flags = parseRunnerArgs(process.argv.slice(2));
	if (flags.help) {
		console.log(USAGE);
		return;
	}
	const replay = flags.replay === true;
	const model = String(flags.model ?? DEFAULT_MODEL);
	const effort = String(flags.effort ?? DEFAULT_EFFORT);
	const repeat = Number(flags.repeat ?? 1);
	const timeoutMs = Number(flags.timeout ?? DEFAULT_TIMEOUT_MS);
	const outDir = path.resolve(ROOT, String(flags.out ?? 'evals/results'));
	const fixtures = readJson(path.join(ROOT, 'evals/fixtures.json'));

	const all = loadCases();
	const problems = all.flatMap((c) => caseProblems(c, { fixtures }));
	if (problems.length) throw new Error(`Invalid cases:\n${problems.join('\n')}`);
	let cases = filterCases(all, typeof flags.filter === 'string' ? flags.filter : undefined);
	if (flags['ci-only'] || replay) cases = cases.filter((c) => c.ci === true);
	if (!cases.length) throw new Error('No cases match.');

	const key = replay ? '' : apiKey();
	if (!replay && !key) throw new Error('No ANTHROPIC_API_KEY in the environment or .dev.vars.');
	/** @type {Record<string, any>} */
	const recordings = {};
	if (replay) for (const c of cases) if (existsSync(recordingPath(c.id))) recordings[c.id] = readJson(recordingPath(c.id));

	const items = cases.flatMap((c) => Array.from({ length: repeat }, (_, i) => ({ case: c, attempt: i + 1 })));
	const shards = shard(items, Number(flags.concurrency ?? 4));
	const started = new Date();
	console.log(`Running ${cases.length} case(s) × ${repeat} on ${replay ? 'recordings' : model} in ${shards.length} shard(s)…`);

	const tmp = mkdtempSync(path.join(tmpdir(), 'assistant-evals-'));
	let lines;
	try {
		lines = (
			await Promise.all(
				shards.map((s, i) =>
					runShard({ mode: replay ? 'replay' : 'live', model, effort, timeoutMs, fixtures, items: s, recordings }, key, tmp, i)
				)
			)
		).flat();
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}

	const byId = new Map(cases.map((c) => [c.id, c]));
	const judge = flags['no-judge'] || replay ? undefined : makeJudge(String(flags['judge-model'] ?? JUDGE_MODEL), key);
	const entries = [];
	for (const item of items) {
		const run = lines.find((l) => l.id === item.case.id && l.attempt === item.attempt) ?? { id: item.case.id, error: 'no result (shard crashed?)' };
		const c = byId.get(item.case.id);
		const obs = { toolCalls: [], offered: [], tiers: {}, text: '', finalText: '', stopReason: 'error', refs: {}, ...run };
		const g = await gradeRun(obs, c, { judge, ...(replay ? { only: ['tool_calls'] } : {}) });
		entries.push({
			id: c.id,
			category: c.category,
			attempt: item.attempt,
			pass: g.pass,
			grades: g.grades,
			costMicros: obs.costMicros ?? 0,
			latencyMs: obs.latencyMs ?? 0,
			error: obs.error ?? null,
			toolCalls: obs.toolCalls,
			text: obs.text,
			transcript: obs.transcript ?? []
		});
		if (flags.record && item.attempt === 1 && c.ci && Array.isArray(run.responses)) {
			const tc = await gradeRun(obs, c, { only: ['tool_calls'] });
			if (tc.pass) {
				mkdirSync(RECORDINGS_DIR, { recursive: true });
				writeFileSync(recordingPath(c.id), `${JSON.stringify(makeRecording(c, run.responses, run.refs ?? {}, { model, effort }), null, '\t')}\n`);
			} else console.warn(`not recorded: ${c.id} fails its tool_calls graders (kept the old recording)`);
		}
	}

	mkdirSync(outDir, { recursive: true });
	const meta = {
		started_at: started.toISOString(),
		finished_at: new Date().toISOString(),
		mode: replay ? 'replay' : 'live',
		model: replay ? 'recordings' : model,
		effort: replay ? null : effort,
		judge_model: judge ? String(flags['judge-model'] ?? JUDGE_MODEL) : null,
		repeat,
		filter: flags.filter ?? null
	};
	const diff = diffRuns(previousEntries(outDir), entries);
	const base = path.join(outDir, stamp(started));
	writeFileSync(`${base}.json`, `${JSON.stringify({ meta, summary: summarize(entries), diff, entries }, null, '\t')}\n`);
	writeFileSync(`${base}.md`, markdownReport({ meta, entries, diff, cases, transcripts: !flags['no-transcripts'] }));
	const s = summarize(entries);
	console.log(`Pass rate ${(s.passRate * 100).toFixed(1)}% (${s.passed}/${s.cases}). Results: ${path.relative(ROOT, base)}.md`);
	if (diff?.newFailures.length) console.log(`New failures: ${diff.newFailures.join(', ')}`);
	process.exitCode = s.passed === s.cases ? 0 : 1;
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : String(e));
	process.exitCode = 1;
});
