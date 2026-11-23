// #587: a published form as plain, script-free HTML — the newsletter archive's Subscribe popup and
// /newsletter/subscribe. The archive pages run under PUBLIC_PAGE_CSP (`script-src 'none'`) and,
// on the public host, can't reach /f/<slug> or /_app/*, so the SvelteKit FormRenderer can't be
// used there. Pure: no DB, no request. Every value from the spec is escaped; the intro and
// paragraph text go through the assistant's safe Markdown renderer (raw HTML escaped), like
// FormRenderer.
import { renderAssistantMarkdown } from '$lib/assistant-markdown';
import { fieldTypeInfo, ratingOf, styleVars, type FormField, type FormFieldType, type FormSpec } from '$lib/forms';
import { RATING_CSS, ratingGroupHtml } from '$lib/form-rating';

/** = form-submit's HONEYPOT_NAME (a test keeps them equal). Not imported: form-submit reaches
 *  Postmark, and the archive module (which renders this) must stay free of send paths. */
export const PLAIN_HONEYPOT_NAME = '_hp_url';

/** Field types the plain renderer can show as native controls. A page break needs Back / Next
 *  (script), so a multi-page form is refused instead. */
export const PLAIN_FIELD_TYPES: readonly FormFieldType[] = [
	'short_text',
	'long_text',
	'email',
	'phone',
	'number',
	'url',
	'date',
	'select',
	'radio',
	'checkboxes',
	'checkbox',
	'consent',
	'rating',
	'topics',
	'hidden',
	'heading',
	'paragraph'
];

/** Why this form can't be the archive's sign-up form, or null when it can. */
export function plainFormProblem(form: { status: string; spec: FormSpec }): string | null {
	if (form.status !== 'published') return 'That form isn’t published. Publish it first, then choose it here.';
	const spec = form.spec;
	if (spec.fields.some((f) => f.type === 'page_break')) {
		return 'That form has more than one page. The newsletter archive can only show a one-page form (remove the page breaks).';
	}
	if (spec.fields.some((f) => f.show_when)) {
		return 'That form uses conditional logic (questions that show or hide). The newsletter archive can only show a form without it.';
	}
	const odd = spec.fields.find((f) => !PLAIN_FIELD_TYPES.includes(f.type));
	if (odd) {
		const kind = fieldTypeInfo(odd.type)?.label ?? odd.type;
		return `That form has a “${kind}” question the newsletter archive can’t show without script.`;
	}
	return null;
}

const esc = (s: unknown) =>
	String(s ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');

const INPUT_TYPE: Partial<Record<FormFieldType, string>> = {
	email: 'email',
	number: 'number',
	url: 'url',
	date: 'date',
	phone: 'tel'
};

const AUTOCOMPLETE: Record<string, string> = {
	email: 'email',
	first_name: 'given-name',
	last_name: 'family-name',
	name: 'name',
	company: 'organization',
	phone: 'tel'
};

/** The form's style as a `style` attribute value (escaped `--f-*` variables), for any wrapper
 *  that paints with them (the popup sits on the form's surface colour). */
export function plainFormStyle(spec: Pick<FormSpec, 'style'>): string {
	return esc(styleVars(spec.style));
}

export type PlainFormOptions = {
	/** The POST target — root-relative, so it works on the public host and the CRM host. */
	action: string;
	/** Prefix for element ids (one form per page; keep ids unique if that ever changes). */
	idPrefix?: string;
	/** Heading level of the form's title: 'h2' in the popup, 'h1' on the standalone page. */
	heading?: 'h1' | 'h2';
	/** Put `autofocus` on the first field (focused when the popup opens). */
	autofocus?: boolean;
	/** A message from a failed post (`?error=`), shown above the submit button. */
	error?: string | null;
};

/** The form as HTML: title, intro, questions (labels, required marks, help), the honeypot and
 *  the submit button. Wrapped in `.nl-form`, carrying the form's style as `--f-*` variables. */
export function renderPlainForm(spec: FormSpec, opts: PlainFormOptions): string {
	const prefix = opts.idPrefix ?? 'nlf';
	const h = opts.heading ?? 'h2';
	let focusPending = !!opts.autofocus;
	const focus = () => {
		if (!focusPending) return '';
		focusPending = false;
		return ' autofocus';
	};
	const req = (f: FormField) => (f.required ? '<span class="nl-req" aria-hidden="true"> *</span>' : '');
	const parts: string[] = [];
	parts.push(`<${h} class="nl-form-title" id="${esc(prefix)}-title">${esc(spec.title)}</${h}>`);
	if (spec.intro_md.trim()) parts.push(`<div class="nl-form-md nl-form-intro">${renderAssistantMarkdown(spec.intro_md)}</div>`);

	for (const f of spec.fields) {
		const id = `${prefix}-${f.id}`;
		const help = f.help.trim() ? `<p class="nl-form-help" id="${esc(id)}-h">${esc(f.help)}</p>` : '';
		const described = f.help.trim() ? ` aria-describedby="${esc(id)}-h"` : '';
		const required = f.required ? ' required' : '';
		switch (f.type) {
			case 'heading':
				parts.push(`<h3 class="nl-form-h">${esc(f.label)}</h3>`);
				continue;
			case 'paragraph':
				parts.push(`<div class="nl-form-md">${renderAssistantMarkdown(f.label)}</div>`);
				continue;
			case 'hidden':
				parts.push(`<input type="hidden" name="${esc(f.key)}" value="">`);
				continue;
			case 'page_break':
				continue; // refused by plainFormProblem; never rendered
			case 'checkbox':
			case 'consent':
				parts.push(
					`<div class="nl-form-q"><label class="nl-form-tick"><input type="checkbox" name="${esc(f.key)}" value="on"${required}${described}${focus()}><span>${esc(f.label)}${req(f)}</span></label>${help}</div>`
				);
				continue;
			case 'radio':
			case 'checkboxes':
			case 'topics': {
				const type = f.type === 'radio' ? 'radio' : 'checkbox';
				const opts2 = f.options
					.map(
						(o, i) =>
							`<label class="nl-form-tick"><input type="${type}" name="${esc(f.key)}" value="${esc(o.value)}"${f.type === 'radio' ? required : ''}${i === 0 ? focus() : ''}><span>${esc(o.label || o.value)}</span></label>`
					)
					.join('');
				parts.push(`<fieldset class="nl-form-q"${described}><legend>${esc(f.label)}${req(f)}</legend>${opts2}${help}</fieldset>`);
				continue;
			}
			case 'rating': {
				// #589: the same radio group FormRenderer draws, styled by RATING_CSS (no script).
				parts.push(
					ratingGroupHtml(ratingOf(f), {
						name: f.key,
						legend: f.label,
						legendSuffix: req(f),
						required: f.required,
						describedBy: f.help.trim() ? `${id}-h` : undefined,
						className: 'nl-form-q',
						autofocus: focus() !== '',
						after: help
					})
				);
				continue;
			}
			case 'select': {
				const options = [`<option value="">${esc(f.placeholder || 'Choose…')}</option>`]
					.concat(f.options.map((o) => `<option value="${esc(o.value)}">${esc(o.label || o.value)}</option>`))
					.join('');
				parts.push(
					`<div class="nl-form-q"><label for="${esc(id)}">${esc(f.label)}${req(f)}</label><select id="${esc(id)}" name="${esc(f.key)}"${required}${described}${focus()}>${options}</select>${help}</div>`
				);
				continue;
			}
			case 'long_text':
				parts.push(
					`<div class="nl-form-q"><label for="${esc(id)}">${esc(f.label)}${req(f)}</label><textarea id="${esc(id)}" name="${esc(f.key)}" rows="4" maxlength="5000"${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}${required}${described}${focus()}></textarea>${help}</div>`
				);
				continue;
			default: {
				const type = INPUT_TYPE[f.type] ?? 'text';
				const ac = f.map?.to === 'contact' ? AUTOCOMPLETE[f.map.field] : undefined;
				parts.push(
					`<div class="nl-form-q"><label for="${esc(id)}">${esc(f.label)}${req(f)}</label><input id="${esc(id)}" type="${type}" name="${esc(f.key)}"${ac ? ` autocomplete="${ac}"` : ''}${f.type === 'url' ? ' inputmode="url"' : ''}${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''} maxlength="${f.type === 'url' ? 2000 : 500}"${required}${described}${focus()}>${help}</div>`
				);
			}
		}
	}

	// Off-screen honeypot: people never see or fill it (handleSubmission stores a filled one as spam).
	parts.push(
		`<div class="nl-form-hp" aria-hidden="true"><label>Website <input type="text" name="${PLAIN_HONEYPOT_NAME}" tabindex="-1" autocomplete="off" value=""></label></div>`
	);
	if (opts.error) parts.push(`<p class="nl-form-err" role="alert">${esc(opts.error)}</p>`);
	parts.push(`<div class="nl-form-actions"><button type="submit" class="nl-form-submit">${esc(spec.settings.submit_label || 'Submit')}</button></div>`);

	return `<div class="nl-form" style="${plainFormStyle(spec)}"><form method="post" action="${esc(opts.action)}" aria-labelledby="${esc(prefix)}-title">${parts.join('')}</form></div>`;
}

/** CSS for `.nl-form` and the Subscribe popup. The form's own colours, radius and font come in
 *  as `--f-*`; the popup sits on the form's surface colour. `@supports selector(:popover-open)`:
 *  browsers without the popover attribute get the plain link to /newsletter/subscribe instead
 *  of a button that would do nothing. The popup's Close button is its own sticky row at the top
 *  right, never a float: the form is a flex container, which would shrink to sit beside a float. */
export const PLAIN_FORM_CSS = `
  .nl-form { color:var(--f-text); font-family:var(--f-font); font-size:16px; line-height:1.5; text-align:left; }
  .nl-form form { display:flex; flex-direction:column; gap:18px; margin:0; }
  .nl-form-title { margin:0; font-size:24px; line-height:1.25; font-weight:700; color:var(--f-text); }
  h1.nl-form-title { font-size:clamp(28px, 4vw, 38px); }
  .nl-form-h { margin:8px 0 0; font-size:19px; line-height:1.3; }
  .nl-form-intro { color:var(--f-muted); }
  .nl-form-md p { margin:0 0 10px; } .nl-form-md p:last-child { margin-bottom:0; }
  .nl-form-md a { color:inherit; text-decoration-color:var(--f-accent); }
  .nl-form-q { display:flex; flex-direction:column; gap:6px; border:0; margin:0; padding:0; min-width:0; }
  .nl-form-q > label, .nl-form-q legend { font-size:15px; font-weight:600; color:var(--f-text); padding:0; }
  .nl-form-q legend { margin-bottom:6px; }
  .nl-req { color:var(--f-accent); }
  .nl-form input:not([type="checkbox"]):not([type="radio"]), .nl-form select, .nl-form textarea {
    font:inherit; color:var(--f-text); background:var(--f-surface); border:1px solid var(--f-border);
    border-radius:var(--f-radius); padding:9px 12px; width:100%; min-height:44px; box-sizing:border-box; }
  .nl-form textarea { resize:vertical; }
  .nl-form input:focus-visible, .nl-form select:focus-visible, .nl-form textarea:focus-visible, .nl-form button:focus-visible {
    outline:2px solid var(--f-accent); outline-offset:2px; }
  .nl-form-tick { display:flex; align-items:flex-start; gap:10px; font-size:15px; font-weight:400; cursor:pointer; }
  .nl-form-tick input { margin:4px 0 0; width:16px; height:16px; accent-color:var(--f-accent); flex:none; }
  .nl-form-help { margin:0; font-size:13px; line-height:1.45; color:var(--f-muted); }
  .nl-form-err { margin:0; font-size:14px; color:#b34846; }
  .nl-form-hp { position:absolute; left:-10000px; top:auto; width:1px; height:1px; overflow:hidden; }
  .nl-form-actions { margin-top:6px; }
  .nl-form-submit { font:inherit; font-size:16px; font-weight:650; border-radius:var(--f-radius); padding:11px 22px; min-height:44px;
    cursor:pointer; background:var(--f-accent); color:var(--f-on-accent); border:1px solid var(--f-accent); }
  .nl-form-submit:hover { filter:brightness(0.92); }
  .nl-sub-open { display:none; font:inherit; border:0; cursor:pointer; }
  .nl-pop { display:none; }
  @supports selector(:popover-open) {
    .nl-sub-open { display:inline-block; }
    .nl-sub-link { display:none !important; }
    .nl-pop:popover-open { display:block; position:fixed; inset:0; margin:auto; box-sizing:border-box;
      width:min(560px, calc(100vw - 32px)); height:fit-content; max-height:calc(100dvh - 32px); overflow:auto;
      padding:28px; border:1px solid var(--f-border); border-radius:16px; background:var(--f-surface); color:var(--f-text);
      box-shadow:0 24px 64px rgba(0,0,0,0.28); }
    .nl-pop::backdrop { background:rgba(10,14,20,0.55); }
  }
  .nl-pop-close { position:sticky; top:0; display:block; width:fit-content; margin:-12px -12px 8px auto; box-sizing:border-box;
    min-width:44px; min-height:44px; font:inherit; font-size:14px; font-weight:600; padding:10px 16px; border-radius:999px;
    border:1px solid var(--f-border); background:var(--f-surface); color:var(--f-text); cursor:pointer; z-index:1; }
  .nl-pop-close:focus-visible { outline:2px solid var(--f-accent); outline-offset:2px; }
  .nl-top-sub { margin:0 0 28px; }
  .nl-top-sub .nl-sub-open, .nl-top-sub a { display:inline-block; padding:8px 18px; border-radius:999px; border:1px solid var(--nl-brand);
    background:transparent; color:var(--nl-brand); font-size:15px; font-weight:650; text-decoration:none; line-height:1.4; }
  .nl-top-sub .nl-sub-open { display:none; }
  @supports selector(:popover-open) { .nl-top-sub .nl-sub-open { display:inline-block; } }
  .nl-sub .nl-sub-open { display:none; padding:12px 24px; border-radius:999px; background:var(--nl-on-brand); color:var(--nl-brand); font-weight:700; font-size:16px; }
  @supports selector(:popover-open) { .nl-sub .nl-sub-open { display:inline-block; } }
  .nl-signup-page { max-width:560px; }
  .nl-signup-page .nl-form { padding:28px; border:1px solid var(--f-border); border-radius:16px; background:var(--f-surface); }
  .nl-back { margin:24px 0 0; font-size:16px; }
  .nl-thanks { font-size:calc(var(--nl-size) + 1px); }
  .nl-thanks p { margin:0 0 12px; }
  @media (max-width:600px) {
    @supports selector(:popover-open) {
      .nl-pop:popover-open { width:100vw; max-width:100vw; max-height:100dvh; border-radius:0; border:0; padding:20px 16px 28px; }
    }
    .nl-signup-page .nl-form { padding:20px 16px; }
  }
${RATING_CSS}`;
