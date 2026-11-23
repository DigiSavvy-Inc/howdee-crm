// Forms: share & embed (#515). Universal (builder Share tab, the public page, the embed script
// route, the send path). Nothing here touches the DB.
//
//   - allowed origins: `originProblem` / `cleanOriginLine` (the Share tab's editor + validateFormSpec)
//   - the embed script: `embedScript` (served by /f/<slug>/embed.js), its origin check
//     `embedOriginAllowed` (inlined into the script with toString, so the test exercises the same code)
//   - copy-paste snippets: `scriptSnippet`, `iframeSnippet`, `rawHtmlSnippet`
//   - the campaign merge tag `{{form:<slug>}}`: `hasFormTags`, `fillFormTags`, `formTag`
import { fieldsByPage, isAnswerType, ratingOf, type FormSpec } from '$lib/forms';
import { cleanOriginLine, originProblem, validOrigins } from '$lib/form-origins';

export { cleanOriginLine, originProblem, validOrigins };

/** postMessage types between the embedded page and embed.js. */
export const EMBED_HEIGHT_MSG = 'dsv-form:height';
export const EMBED_REDIRECT_MSG = 'dsv-form:redirect';
export const IFRAME_DEFAULT_HEIGHT = 600;
/** #669: how long browsers and CDNs may cache `embed.js` (seconds), so an allowed-origins change reaches the script within a minute. */
export const EMBED_SCRIPT_MAX_AGE = 60;

// ---------------------------------------------------------------------------------------
// Allowed origins

/** The "Where it works" line on the Share tab. */
export function whereItWorks(list: readonly string[] | null | undefined): string {
	const v = validOrigins(list);
	return v.length ? `Only on ${v.join(', ')} (and this CRM).` : 'Anywhere — no allowed origins are set, so any site can embed this form.';
}

/**
 * embed.js's origin check (the page that holds the container). Empty `allowed` = anywhere; the
 * CRM origin is always fine. Written in plain ES5 with no helpers or nested functions: its source
 * is inlined into the served script with `toString()`.
 */
export function embedOriginAllowed(origin: string, allowed: string[], crm: string): boolean {
	if (!allowed || !allowed.length) return true;
	var o = String(origin || '').toLowerCase().replace(/\/+$/, '');
	if (!o || o === 'null') return false;
	if (crm && o === String(crm).toLowerCase().replace(/\/+$/, '')) return true;
	for (var i = 0; i < allowed.length; i++) {
		if (String(allowed[i]).toLowerCase().replace(/\/+$/, '') === o) return true;
	}
	return false;
}

/** `frame-ancestors` for /f/* pages: `'self'` normally; embedded = the allowed origins, or `*` when none. */
export function frameAncestors(allowed: readonly string[] | null | undefined, embed: boolean): string {
	if (!embed) return "frame-ancestors 'self'";
	const v = validOrigins(allowed);
	return v.length ? `frame-ancestors 'self' ${v.join(' ')}` : 'frame-ancestors *';
}

// ---------------------------------------------------------------------------------------
// The embed script

const js = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/**
 * `/f/<slug>/embed.js`: dependency-free, no eval. Finds `[data-dsv-form="<slug>"]`, refuses when
 * the host origin isn't allowed, creates the iframe (prefill from `data-email` / `data-<key>` and
 * the host page's `utm_*`), sizes it from `dsv-form:height` messages and follows
 * `dsv-form:redirect` — only messages from the CRM origin and that iframe count.
 */
export function embedScript(o: { slug: string; name: string; crmOrigin: string; allowed: readonly string[]; keys: readonly string[] }): string {
	const allowed = validOrigins(o.allowed);
	return `/* ${o.slug.replace(/\*\//g, '')} — form embed (#515) */
(function () {
	'use strict';
	var SLUG = ${js(o.slug)};
	var CRM = ${js(o.crmOrigin)};
	var ALLOWED = ${js(allowed)};
	var TITLE = ${js(o.name)};
	var KEYS = ${js(o.keys)};
	var UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
	var originOk = ${embedOriginAllowed.toString()};
	if (!originOk(window.location.origin, ALLOWED, CRM)) {
		if (typeof console !== 'undefined') console.warn('This form can’t be embedded on ' + window.location.origin + '. Add it to the form’s allowed origins.');
		return;
	}
	var frames = [];
	function build(box) {
		if (box.getAttribute('data-dsv-ready')) return;
		box.setAttribute('data-dsv-ready', '1');
		var q = ['embed=1', 'origin=' + encodeURIComponent(window.location.origin), 'page_url=' + encodeURIComponent(window.location.href.slice(0, 500))];
		if (document.referrer) q.push('referrer=' + encodeURIComponent(document.referrer.slice(0, 500)));
		var email = box.getAttribute('data-email');
		if (email) q.push('email=' + encodeURIComponent(email));
		for (var i = 0; i < KEYS.length; i++) {
			var v = box.getAttribute('data-' + KEYS[i]);
			if (v !== null && KEYS[i] !== 'email') q.push(encodeURIComponent(KEYS[i]) + '=' + encodeURIComponent(v));
		}
		var params = new URLSearchParams(window.location.search);
		for (var u = 0; u < UTM.length; u++) {
			var uv = params.get(UTM[u]);
			if (uv) q.push(UTM[u] + '=' + encodeURIComponent(uv.slice(0, 200)));
		}
		var f = document.createElement('iframe');
		f.src = CRM + '/f/' + encodeURIComponent(SLUG) + '?' + q.join('&');
		f.title = TITLE;
		f.loading = 'lazy';
		f.style.width = '100%';
		f.style.border = '0';
		f.style.height = '${IFRAME_DEFAULT_HEIGHT}px';
		f.setAttribute('scrolling', 'no');
		box.appendChild(f);
		frames.push(f);
	}
	function scan() {
		var boxes = document.querySelectorAll('[data-dsv-form]');
		for (var i = 0; i < boxes.length; i++) if (boxes[i].getAttribute('data-dsv-form') === SLUG) build(boxes[i]);
	}
	window.addEventListener('message', function (e) {
		if (e.origin !== CRM) return;
		var d = e.data;
		if (!d || typeof d !== 'object' || d.slug !== SLUG) return;
		for (var i = 0; i < frames.length; i++) {
			if (frames[i].contentWindow !== e.source) continue;
			if (d.type === ${js(EMBED_HEIGHT_MSG)} && typeof d.height === 'number' && d.height > 0) {
				frames[i].style.height = Math.min(Math.ceil(d.height), 20000) + 'px';
			} else if (d.type === ${js(EMBED_REDIRECT_MSG)} && typeof d.url === 'string' && /^https?:\\/\\//i.test(d.url)) {
				window.location.href = d.url;
			}
		}
	});
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan);
	else scan();
})();
`;
}

// ---------------------------------------------------------------------------------------
// Copy-paste snippets (Share & embed tab)

const attr = (s: string) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function scriptSnippet(base: string, slug: string): string {
	return `<div data-dsv-form="${attr(slug)}"></div>\n<script async src="${attr(base)}/f/${attr(slug)}/embed.js"></script>`;
}

export function iframeSnippet(base: string, slug: string, name: string, height: number): string {
	const h = Number.isFinite(height) && height > 0 ? Math.min(Math.round(height), 5000) : IFRAME_DEFAULT_HEIGHT;
	return `<iframe src="${attr(base)}/f/${attr(slug)}?embed=1" title="${attr(name)}" loading="lazy" style="width:100%;height:${h}px;border:0"></iframe>`;
}

/** A plain HTML form posting to the submit URL: one labelled input per question, the honeypot included. */
export function rawHtmlSnippet(base: string, slug: string, spec: Pick<FormSpec, 'fields' | 'settings'>, honeypot = '_hp_url'): string {
	const lines: string[] = [`<form action="${attr(base)}/f/${attr(slug)}/submit" method="post">`];
	let n = 0;
	for (const page of fieldsByPage(spec.fields)) {
		for (const f of page) {
			if (!isAnswerType(f.type)) continue;
			const id = `dsv-${attr(slug)}-${++n}`;
			const name = attr(f.key);
			const label = attr(f.label || f.key);
			const req = f.required ? ' required' : '';
			if (f.type === 'hidden') {
				lines.push(`  <input type="hidden" name="${name}" value="">`);
			} else if (f.type === 'checkbox' || f.type === 'consent') {
				lines.push(`  <p><label><input type="checkbox" name="${name}" value="on"${req}> ${label}</label></p>`);
			} else if (f.type === 'radio' || f.type === 'checkboxes' || f.type === 'topics' || f.type === 'rating') {
				const type = f.type === 'checkboxes' || f.type === 'topics' ? 'checkbox' : 'radio';
				lines.push(`  <fieldset>`, `    <legend>${label}</legend>`);
				let opts: { value: string; label: string }[] = f.options;
				if (f.type === 'rating') {
					const r = ratingOf(f);
					opts = [];
					for (let i = r.min; i <= r.max; i++) opts.push({ value: String(i), label: String(i) });
				}
				for (const o of opts) lines.push(`    <label><input type="${type}" name="${name}" value="${attr(o.value)}"> ${attr(o.label || o.value)}</label>`);
				lines.push(`  </fieldset>`);
			} else if (f.type === 'select') {
				lines.push(`  <p><label for="${id}">${label}</label>`, `  <select id="${id}" name="${name}"${req}>`, `    <option value="">Choose…</option>`);
				for (const o of f.options) lines.push(`    <option value="${attr(o.value)}">${attr(o.label || o.value)}</option>`);
				lines.push(`  </select></p>`);
			} else if (f.type === 'long_text') {
				lines.push(`  <p><label for="${id}">${label}</label>`, `  <textarea id="${id}" name="${name}" rows="4"${req}></textarea></p>`);
			} else {
				const type = f.type === 'email' ? 'email' : f.type === 'number' ? 'number' : f.type === 'url' ? 'url' : f.type === 'date' ? 'date' : f.type === 'phone' ? 'tel' : 'text';
				lines.push(`  <p><label for="${id}">${label}</label>`, `  <input id="${id}" type="${type}" name="${name}"${req}></p>`);
			}
		}
	}
	lines.push(
		`  <!-- Leave this empty and hidden: it catches bots. -->`,
		`  <div style="position:absolute;left:-10000px" aria-hidden="true"><input type="text" name="${attr(honeypot)}" tabindex="-1" autocomplete="off" value=""></div>`,
		`  <button type="submit">${attr(spec.settings.submit_label || 'Submit')}</button>`,
		`</form>`
	);
	return lines.join('\n');
}

// ---------------------------------------------------------------------------------------
// Campaign merge tag {{form:<slug>}}

export const formTag = (slug: string) => `{{form:${slug}}}`;

// Raw, or percent-encoded inside an href (`%7B%7Bform:slug%7D%7D`, colon maybe `%3A`).
const FORM_TAG_RE = /(?:\{\{|%7B%7B)\s*form(?::|%3A)([a-z0-9][a-z0-9-]{0,79})\s*(?:\}\}|%7D%7D)/gi;

export function hasFormTags(s: string | null | undefined): boolean {
	FORM_TAG_RE.lastIndex = 0;
	return !!s && FORM_TAG_RE.test(s);
}

/** Is `inner` (the text between the braces) a form tag? For the pre-send unknown-tag check. */
export function isFormTagToken(inner: string): boolean {
	return /^\s*form(?::|%3A)[a-z0-9][a-z0-9-]{0,79}\s*$/i.test(inner);
}

/** The prefilled link for one contact: `<base>/f/<slug>?c=<token>`; no token = the plain form. */
export function formLinkUrl(base: string, slug: string, token: string | null | undefined): string {
	const url = `${base.replace(/\/+$/, '')}/f/${slug.toLowerCase()}`;
	return token ? `${url}?c=${encodeURIComponent(token)}` : url;
}

/** Replace every `{{form:<slug>}}` with that contact's prefilled link. */
export function fillFormTags(template: string, base: string, token: string | null | undefined): string {
	if (!template) return template;
	return template.replace(FORM_TAG_RE, (_m, slug: string) => formLinkUrl(base, slug, token));
}
