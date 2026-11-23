// #619: defined custom fields — storage. Table `custom_fields` (migration 0123). Contact data
// stays in contacts.meta; nothing here reads or writes it except for counts and the list of
// keys that have no definition yet. Vocabulary and validation: $lib/custom-fields.
import {
	CUSTOM_FIELD_LIMITS,
	FIELD_CAP_MESSAGE,
	isBuiltInKey,
	isCustomFieldType,
	isFormProtectedKey,
	labelFromKey,
	validateField,
	type CustomField,
	type FieldInput,
	type FieldOption
} from '$lib/custom-fields';

type Row = {
	id: number;
	key: string;
	label: string;
	type: string;
	options: string | null;
	position: number;
	archived_at: string | null;
};

const COLS = 'id, key, label, type, options, position, archived_at';
/** contacts.meta as an object, '{}' when missing or malformed. */
const META_OBJ = `CASE WHEN json_valid(c.meta) AND json_type(c.meta) = 'object' THEN c.meta ELSE '{}' END`;

function toField(r: Row): CustomField {
	let options: string[] = [];
	try {
		const o = JSON.parse(r.options ?? '[]');
		if (Array.isArray(o)) options = o.map(String);
	} catch {
		/* junk → none */
	}
	return {
		id: r.id,
		key: r.key,
		label: r.label,
		type: isCustomFieldType(r.type) ? r.type : 'text',
		options,
		position: r.position,
		archived_at: r.archived_at,
		built_in: isBuiltInKey(r.key)
	};
}

export type Result<T> = { ok: true; field: T } | { ok: false; error: string; status: number };

/** Every definition in position order. Archived ones only with `includeArchived`. */
export async function listCustomFields(db: D1Database, opts: { includeArchived?: boolean } = {}): Promise<CustomField[]> {
	const where = opts.includeArchived ? '' : 'WHERE archived_at IS NULL';
	const rows = await db.prepare(`SELECT ${COLS} FROM custom_fields ${where} ORDER BY position, id`).all<Row>();
	return rows.results.map(toField);
}

/** What pickers get: active fields, position order (plus `keep` keys even when archived, so an
 *  existing mapping still shows its label). */
export async function fieldPicker(db: D1Database, keep: string[] = []): Promise<FieldOption[]> {
	const all = await listCustomFields(db, { includeArchived: keep.length > 0 });
	return all
		.filter((f) => !f.archived_at || keep.includes(f.key))
		.map((f) => ({ key: f.key, label: f.archived_at ? `${f.label} (archived)` : f.label, type: f.type, options: f.options }));
}

/** The form builder's picker ("Maps to: Custom field", "Set fields", GET /api/custom-fields):
 *  `fieldPicker` without the keys only the app writes (FORM_PROTECTED_KEYS), even when kept. */
export async function formFieldPicker(db: D1Database, keep: string[] = []): Promise<FieldOption[]> {
	return (await fieldPicker(db, keep)).filter((f) => !isFormProtectedKey(f.key));
}

/** The cap counts active fields only (the 0123 seed is uncapped; archiving frees a slot). */
async function atFieldCap(db: D1Database): Promise<boolean> {
	const count = await db.prepare('SELECT COUNT(*) AS n FROM custom_fields WHERE archived_at IS NULL').first<{ n: number }>();
	return (count?.n ?? 0) >= CUSTOM_FIELD_LIMITS.fields;
}

export async function getCustomField(db: D1Database, id: number): Promise<CustomField | null> {
	const r = await db.prepare(`SELECT ${COLS} FROM custom_fields WHERE id = ?`).bind(id).first<Row>();
	return r ? toField(r) : null;
}

/** Lookup by key (archived included). */
export async function customFieldByKey(db: D1Database, key: string): Promise<CustomField | null> {
	const r = await db.prepare(`SELECT ${COLS} FROM custom_fields WHERE key = ?`).bind(key).first<Row>();
	return r ? toField(r) : null;
}

export async function createCustomField(db: D1Database, input: FieldInput): Promise<Result<CustomField>> {
	const v = validateField(input);
	if (!v.ok) return { ok: false, error: v.error, status: 400 };
	if (isBuiltInKey(v.key) && v.type !== 'text') return { ok: false, error: 'Built-in fields are text.', status: 400 };
	if (await atFieldCap(db)) return { ok: false, error: FIELD_CAP_MESSAGE, status: 400 };
	if (await customFieldByKey(db, v.key)) return { ok: false, error: `A field with the key “${v.key}” already exists.`, status: 409 };
	try {
		const r = await db
			.prepare(
				`INSERT INTO custom_fields (key, label, type, options, position)
				 VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM custom_fields))
				 RETURNING ${COLS}`
			)
			.bind(v.key, v.label, v.type, JSON.stringify(v.options))
			.first<Row>();
		return { ok: true, field: toField(r!) };
	} catch (e) {
		if (String(e).includes('UNIQUE')) return { ok: false, error: `A field with the key “${v.key}” already exists.`, status: 409 };
		throw e;
	}
}

/** Edit the label, type and options. The key never changes (contact data is keyed by it).
 *  A built-in field keeps its type. */
export async function updateCustomField(
	db: D1Database,
	id: number,
	input: { label?: string; type?: string; options?: unknown }
): Promise<Result<CustomField>> {
	const cur = await getCustomField(db, id);
	if (!cur) return { ok: false, error: 'Field not found.', status: 404 };
	const type = input.type ?? cur.type;
	if (cur.built_in && type !== cur.type) return { ok: false, error: 'A built-in field’s type can’t change.', status: 400 };
	const v = validateField({ key: cur.key, label: input.label ?? cur.label, type, options: input.options ?? cur.options }, { requireKey: true });
	if (!v.ok) return { ok: false, error: v.error, status: 400 };
	const r = await db
		.prepare(`UPDATE custom_fields SET label = ?, type = ?, options = ?, updated_at = datetime('now') WHERE id = ? RETURNING ${COLS}`)
		.bind(v.label, v.type, JSON.stringify(v.options), id)
		.first<Row>();
	return { ok: true, field: toField(r!) };
}

/** Set the order: `ids` first in that order, anything not listed keeps its relative order after. */
export async function reorderCustomFields(db: D1Database, ids: number[]): Promise<void> {
	const all = await listCustomFields(db, { includeArchived: true });
	const byId = new Map(all.map((f) => [f.id, f]));
	const order = [...new Set(ids.filter((i) => byId.has(i)))];
	for (const f of all) if (!order.includes(f.id)) order.push(f.id);
	const stmts = order.map((id, i) => db.prepare('UPDATE custom_fields SET position = ? WHERE id = ?').bind(i + 1, id));
	if (stmts.length) await db.batch(stmts);
}

/** Move one field up / down among the active ones. */
export async function moveCustomField(db: D1Database, id: number, dir: -1 | 1): Promise<void> {
	const active = await listCustomFields(db);
	const i = active.findIndex((f) => f.id === id);
	const j = i + dir;
	if (i < 0 || j < 0 || j >= active.length) return;
	const ids = active.map((f) => f.id);
	[ids[i], ids[j]] = [ids[j], ids[i]];
	await reorderCustomFields(db, ids);
}

/** Hide from pickers. Contact data is never touched. Built-in fields can't be archived. */
export async function archiveCustomField(db: D1Database, id: number): Promise<Result<CustomField>> {
	const cur = await getCustomField(db, id);
	if (!cur) return { ok: false, error: 'Field not found.', status: 404 };
	if (cur.built_in) return { ok: false, error: 'Built-in fields can’t be archived.', status: 400 };
	const r = await db
		.prepare(`UPDATE custom_fields SET archived_at = COALESCE(archived_at, datetime('now')), updated_at = datetime('now') WHERE id = ? RETURNING ${COLS}`)
		.bind(id)
		.first<Row>();
	return { ok: true, field: toField(r!) };
}

/** Back into pickers; refused at the active-field cap. */
export async function restoreCustomField(db: D1Database, id: number): Promise<Result<CustomField>> {
	const cur = await getCustomField(db, id);
	if (!cur) return { ok: false, error: 'Field not found.', status: 404 };
	if (cur.archived_at && (await atFieldCap(db))) return { ok: false, error: FIELD_CAP_MESSAGE, status: 400 };
	const r = await db
		.prepare(`UPDATE custom_fields SET archived_at = NULL, updated_at = datetime('now') WHERE id = ? RETURNING ${COLS}`)
		.bind(id)
		.first<Row>();
	return r ? { ok: true, field: toField(r) } : { ok: false, error: 'Field not found.', status: 404 };
}

/** Contacts holding a non-empty value per key (archived contacts included: it's their data). */
export async function valueCounts(db: D1Database): Promise<Map<string, number>> {
	const rows = await db
		.prepare(
			`SELECT j.key AS key, COUNT(DISTINCT c.id) AS n FROM contacts c, json_each(${META_OBJ}) j
			 WHERE j.value IS NOT NULL AND TRIM(CAST(j.value AS TEXT)) != '' GROUP BY j.key`
		)
		.all<{ key: string; n: number }>();
	return new Map(rows.results.map((r) => [r.key, r.n]));
}

/** Keys found on contacts that have no definition, with how many contacts hold them. */
export async function undefinedKeys(db: D1Database, limit = 200): Promise<{ key: string; count: number; label: string }[]> {
	const rows = await db
		.prepare(
			`SELECT j.key AS key, COUNT(DISTINCT c.id) AS n FROM contacts c, json_each(${META_OBJ}) j
			 WHERE TRIM(j.key) != '' AND j.key NOT IN (SELECT key FROM custom_fields)
			 GROUP BY j.key ORDER BY n DESC, j.key LIMIT ?`
		)
		.bind(limit)
		.all<{ key: string; n: number }>();
	return rows.results.map((r) => ({ key: r.key, count: r.n, label: labelFromKey(r.key) }));
}

/** Forms that map an answer (or a "Set a field" action) to each key: key → form names. */
export async function formsUsingKeys(db: D1Database): Promise<Map<string, { id: number; name: string }[]>> {
	const out = new Map<string, { id: number; name: string }[]>();
	const rows = await db.prepare(`SELECT id, name, spec FROM forms WHERE status != 'archived'`).all<{ id: number; name: string; spec: string }>();
	for (const f of rows.results) {
		let spec: { fields?: { map?: { to?: string; key?: string } | null }[]; outcomes?: { actions?: { type?: string; key?: string }[] }[] };
		try {
			spec = JSON.parse(f.spec);
		} catch {
			continue;
		}
		const keys = new Set<string>();
		for (const fld of spec.fields ?? []) if (fld?.map?.to === 'meta' && fld.map.key) keys.add(fld.map.key);
		for (const o of spec.outcomes ?? []) for (const a of o?.actions ?? []) if (a?.type === 'set_field' && a.key) keys.add(a.key);
		for (const k of keys) {
			const list = out.get(k) ?? [];
			list.push({ id: f.id, name: f.name });
			out.set(k, list);
		}
	}
	return out;
}

/** Define an existing meta key as it is (Settings "Define", the form builder's "define"). */
export async function defineKey(db: D1Database, key: string, input: { label?: string; type?: string; options?: unknown } = {}): Promise<Result<CustomField>> {
	const existing = await customFieldByKey(db, key);
	if (existing) return { ok: true, field: existing };
	return createCustomField(db, { key, label: input.label || labelFromKey(key), type: input.type ?? 'text', options: input.options });
}
