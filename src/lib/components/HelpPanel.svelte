<script lang="ts">
	import { page } from '$app/state';
	import { startTour } from '$lib/tour.svelte';
	import { pwa, promptInstall } from '$lib/pwa.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { iconSvg } from '$lib/icons/icon';
	import { keyLabel, shortcutsTableHtml } from '$lib/shortcuts';
	import { platform } from '$lib/platform.svelte';
	import { DEFAULT_APP_NAME } from '$lib/branding';

	// Floating in-app docs (#65): a ? button lower-left; the panel opens above it with
	// accordion sections. The section matching the current route starts expanded.
	let open = $state(false);
	let filter = $state('');

	type Section = { id: string; title: string; routes: string[]; body: string };

	// Markdown-ish plain HTML strings, kept short and current alongside features.
	// #572: built per platform, so key hints read ⌘K on a Mac and Ctrl+K elsewhere.
	const buildSections = (mac: boolean): Section[] => {
		const k = (combo: string) => keyLabel(combo, mac);
		return [
		{
			id: 'shortcuts',
			title: 'Keyboard shortcuts',
			routes: [],
			body: `<p>Every shortcut works on a Mac and on Windows or Linux (the Windows column applies to Linux too). The hints around the app show the keys for this computer.</p>
${shortcutsTableHtml()}
<p>The email editor has its own: <strong>${k('Mod+B')}</strong>, <strong>${k('Mod+I')}</strong>, <strong>${k('Mod+U')}</strong> for bold, italic and underline, and ${k('Mod+Shift+↑')} / ${k('Mod+Shift+↓')} to move a block; the toolbar's tooltips list the rest.</p>`
		},
		{
			id: 'compose',
			title: 'Compose & merge tags',
			routes: ['/compose', '/campaigns'],
			body: `<p>The <strong>Campaigns</strong> tab has the send log (filters + paging), tiles (sent, delivered, 30-day open/click rate across broadcast sends, scheduled), and <strong>Upcoming</strong> scheduled sends and resends. <strong>New campaign</strong> opens the composer.</p>
<p><strong>Campaign</strong> sends to a list/segment with an unsubscribe footer; <strong>Direct (1:1)</strong> sends to one person with no footer (transactional stream).</p>
<p>Merge tags fill per recipient: <code>{{first_name}}</code> (falls back to “there”), <code>{{name}}</code>, <code>{{last_name}}</code>, <code>{{email}}</code>, <code>{{company}}</code>, and <code>{{field:any-custom-field}}</code>. <code>{{form:&lt;slug&gt;}}</code> is a link to a published form with the recipient's email filled in and hidden (use it as a button or link address).</p>
<p><strong>Start from</strong> picks a template: Blank (markdown), a Builder template (you still write the content — it lands in the template's content area), or Raw HTML (sent as-is).</p>
<p><strong>Schedule:</strong> pick “Schedule” next to the send button and choose a time (your local clock). It fires on the first heartbeat after the time passes (within ~1 min). Cancel or pull forward from the campaign page until it sends.</p>
<p><strong>Links in the editor:</strong> select text and paste a link to link it: a full URL, a bare domain like <code>example.com/talk</code>, an email address or a merge tag like <code>{{field:url}}</code> (pasting over a link replaces its address). Click a link to edit, unlink or open it. A merge-tag link has no fixed URL, so it can't be opened.</p>
<p><strong>Write mode:</strong> the <strong>Write</strong> button next to Edit (or <code>${k('Mod+Shift+F')}</code>) hides the app header, navigation and assistant button, centres the page with larger type and folds the Design panel to a tab on the right edge. Save stays on the page (in the sticky bar at the top where the editor has one). <code>Esc</code> or the button again exits. It's remembered in this browser for every editor page; on phones it only hides the header. In Write mode the formatting toolbar is hidden (select text to format it), and <strong>Writing</strong> picks a <strong>Serif</strong> drafting face (only in the editor; the email keeps its own fonts) and <strong>Focus paragraph</strong>, which dims everything but the block you're in. A line under the page shows the word count and read time.</p>
<p><strong>Quiet editing:</strong> the editor's controls (block handle, the bar above the editor, the formatting toolbar and the Design panel) fade while you type and come back when you move the mouse, focus a control, open a menu or press <code>Tab</code>. Selecting text shows a small bubble with bold, italic, underline, strikethrough, link, Heading 2, Heading 3, quote and clear formatting; <code>Tab</code> from the text reaches it and <code>Esc</code> closes it.</p>
<p><strong>Ask AI:</strong> select text and click <strong>Ask AI</strong> at the start of that bubble (or press <code>${k('Mod+Shift+Enter')}</code>), then pick a quick action (improve, fix spelling, shorter, longer, simplify, change tone, turn into a list, a heading and paragraphs or a button, translate) or type what to change. The result shows in a preview first; nothing in your email changes until you click <strong>Replace</strong> or <strong>Insert below</strong> (one undo step), and you can refine it, try again or discard it. Merge tags must come back unchanged, made-up links are turned into plain text and no new images are added. The selected content and the email or page around it are sent to the AI provider. It shows for people with assistant access while <strong>Settings → Assistant → Permissions → Ask AI in the editor</strong> is on, works in Compose, templates, the global header and footer, automation emails and pages, and counts toward the assistant's spend caps.</p>
<p><strong>Ask AI to write:</strong> on an empty line, type <code>/ai</code> (or <code>/</code> and pick <strong>Ask AI</strong> from the list), then type what to write or pick a starter: <strong>Write an intro</strong>, <strong>Write a call to action</strong>, <strong>Outline this email</strong>, <strong>Continue writing</strong> or <strong>Summarise the email above</strong> (the last two work from what's above the cursor, so they need some content there). The new blocks show in a preview first and only go in at the cursor when you click <strong>Insert</strong> (one undo step); you can refine, try again or discard. Only merge tags this editor offers are used, links and images must already be in the email (a button whose link isn't known goes in with an empty link for you to fill in, and the preview says so). Same access, spend caps and setting as Ask AI above.</p>
<p><strong>Images:</strong> upload PNG, JPG, GIF, WebP, AVIF (converted to WebP on upload because email clients can't show AVIF), up to 5 MB.</p>
<p><strong>Table of contents:</strong> type <code>/</code> and pick <strong>Table of contents</strong> (works in emails, templates and hosted pages). Select the block and use the Design panel to choose which heading levels it lists (H1, H2, H3; H2 by default) and to add an optional title such as “In this issue”. The list builds itself from your headings and updates as you edit them, so there's nothing to keep in sync. Its links jump to each heading on hosted pages and the newsletter archive; in email, jump links work only in some mail clients, and elsewhere the list reads as a plain outline.</p>
<p><strong>Test sends</strong> assemble exactly like the real send — including the template and conditional content, evaluated against the test address's own contact record.</p>
<p><strong>Campaign report clicks:</strong> company mail scanners (Safe Links, Proofpoint, Mimecast) open every link right after delivery. When one recipient "clicks" 3 or more different links within 10 seconds, or the unsubscribe link and another link within 10 seconds, those are counted as scanner fetches: left out of the click counts, the Link clicks table and the engagement score, and noted under Link clicks ("N link fetches by security scanners hidden"). Visits to the unsubscribe page are one <em>Unsubscribe page</em> row at the bottom of Link clicks and never count as clicks.</p>
<p><strong>Campaign report Activity:</strong> the newest tracking events for the campaign, 10 at a time. Filter with the chips (All, Opens, Clicks, Unsubscribes, Bounces; each shows its count — Unsubscribes includes unsubscribe-page visits, Bounces includes spam complaints), pick 10/25/50 rows, or use <strong>Show more</strong>. Hover a time for the exact UTC timestamp. Scanner link fetches are never listed.</p>`
		},
		{
			id: 'conditionals',
			title: 'Conditional content (if/else)',
			routes: [],
			body: `<p>Show different content per recipient, anywhere you write text:</p>
<pre>{{#if tag:hot}}
Let's talk this week.
{{else}}
Enjoy the newsletter.
{{/if}}</pre>
<p>Conditions: <code>tag:name</code>, <code>!tag:name</code>, <code>field:name</code> (exists), <code>field:tier == "hot"</code>, <code>!=</code>, and numeric <code>&gt; &gt;= &lt; &lt;=</code> (e.g. <code>field:score &gt;= 90</code>). Nesting works. <code>{{field:name}}</code> prints a custom field.</p>
<p>In the email builder, select any block → the ${iconSvg('eye', 16)} row sets show/hide rules without writing syntax.</p>
<p>A malformed condition shows up verbatim in your test send (nothing is silently dropped).</p>`
		},
		{
			id: 'templates',
			title: 'Templates & global header/footer',
			routes: ['/templates'],
			body: `<p>Builder templates are <strong>layout shells</strong>: header/footer chrome around a dashed <strong>content area</strong> — what you write in Compose lands there.</p>
<p><strong>Global header &amp; footer</strong> (Templates → Global header &amp; footer) wrap every builder-template send; each template can opt out via its “Include global …” toggles.</p>
<p>Raw HTML templates are full documents sent as-is. Include <code>%%UNSUB_URL%%</code> where the unsubscribe link goes — if missing, the standard footer is appended automatically.</p>
<p>Emails render as table-based 600px HTML (Gmail/Outlook-safe). Use the Edit | Preview tabs; preview shows the true email layout.</p>
<p><strong>Aspect ratio</strong> (image block, Design panel → Dimensions): pick 1:1, 4:3, 3:2, 16:9 or 9:16, then the <strong>Crop position</strong> in the 3×3 grid. The CRM uploads a cropped copy (WebP, at most 1600 px on the long edge) and keeps the original, so <strong>Original</strong> restores it and every re-crop starts from it. The crop is baked into the image, so every inbox shows exactly it. Images from other sites may need uploading first.</p>
<p><strong>Web page</strong> templates design the public newsletter archive, not an email. Blocks above the content area are the page header, blocks below it the footer; Page settings set the background, content width, font, text size and link colour. “Start from default” gives you the built-in design to edit. A block's <strong>Show on</strong> setting (Design panel) limits it to issue pages or the archive list, e.g. a “← All newsletters” link only on issues. An email template's <strong>Copy as newsletter archive page</strong> button makes a Web page template with the same layout (global header and footer included) that you can then pick under Settings → Newsletter archive.</p>`
		},
		{
			id: 'brand-kit',
			title: 'Brand kit (colours & logos)',
			routes: ['/settings/brand-kit', '/compose', '/templates', '/pages'],
			body: `<p>The colour swatches and logos the editors offer as presets — in the text colour menu, the Design panel and every colour picker, and in an image block's <strong>Brand logo</strong> quick insert — come from the <strong>brand kit</strong>. Admins edit it in <strong>Settings → Brand kit</strong>: add, rename, reorder or remove colours (hex) and logos.</p>
<p>Logos are uploaded (PNG or WebP, up to 512 KB; email clients can't show SVG) and stored with the app. Mark each one for a light or a dark background so it's easy to pick the right one.</p>
<p>Changing the kit never changes anything already saved: emails, templates and pages keep the colours and logo images they were made with. The newsletter archive's built-in design shows the logo from <strong>Settings → General → Branding</strong>, or no logo when none is uploaded.</p>
<p>The app name and short name are set in <strong>Settings → General → Branding</strong>. Left blank, they show the default, <strong>${DEFAULT_APP_NAME}</strong>.</p>`
		},
		{
			id: 'newsletter-archive',
			title: 'Newsletter archive',
			routes: ['/settings/newsletter'],
			body: `<p>A public page (<code>/newsletter</code>) listing the newsletters you choose, each shown as a designed web page. It's off until an admin turns it on in <strong>Settings → Newsletter archive</strong>, which also sets the title, intro, Subscribe button link, the web template and whether search engines may index it.</p>
<p><strong>Publishing</strong> (admins): on a sent broadcast's page, <strong>Publish to newsletter archive</strong> (or Remove); several at once from the checkboxes on Campaigns; or tick “Publish to newsletter archive after sending” in Compose (scheduled sends too). <strong>Auto-publish</strong> publishes every broadcast sent to the lists, segments or topics you pick. 1:1 emails, automation emails, drafts and scheduled sends are never published. Each issue gets the next <strong>issue number</strong> when first published (oldest first when you publish several) and keeps it if removed; change or clear it under <strong>Edit archive version</strong>.</p>
<p><strong>Edit archive version</strong> (admins, on a sent broadcast's page, before or after publishing): a web-only title, teaser and body for the archive page, for example to cut “Sorry you couldn't make it” from an event recap. The email that was sent never changes, and the send log, resends and reports keep using it. <strong>Preview</strong> opens the page in a new tab (even unpublished); <strong>Reset to email version</strong> goes back to the email. Campaigns with a raw HTML template can't be edited as blocks: <strong>Start from blank</strong> replaces the email's layout on the web page. Edited issues show <em>edited for web</em>; the page's URL never changes.</p>
<p>Each issue keeps its URL (<code>/newsletter/2026-10-14-subject</code>) forever, even if you remove and re-publish it. Removed issues disappear within 5 minutes.</p>
<p>The page shows the email's own content in the web template: no unsubscribe link, no tracking, no From address, no list name. Personal merge tags use their fallback (“Hi there,”) or disappear. HTML typed into a Markdown email shows as plain text on the archive, apart from simple formatting such as line breaks and bold. Campaigns made from a <strong>raw HTML</strong> template are shown as the email itself in a frame, so they look like the email.</p>
<p><strong>RSS:</strong> <code>/newsletter/feed.xml</code> lists the latest 20 issues, for embedding on a website.</p>
<p><strong>Sign-up form</strong> (admins, Settings → Newsletter archive): pick a published form from Forms. Visitors then see a <strong>Subscribe</strong> button near the top of the archive and of every issue (and in the box at the bottom) that opens the form in a popup on the same page; a sign-up goes through the form like any other (double opt-in, tags, lists, notifications) and ends on a thank-you page. The form also has its own page, <code>/newsletter/subscribe</code>, which you can share and which older browsers open instead of the popup. It works on the public address too. Only one-page forms without conditional logic can be used here; others are refused with the reason. While a form is chosen it replaces the Subscribe URL link; choose “None” to go back to the link.</p>
<p><strong>Public address</strong> (admins, Settings → Newsletter archive): show the archive on your website, e.g. <code>example.com</code> → <code>https://example.com/newsletter</code>. There, every link, image, the feed and the logo point at the website, never at the CRM, and nothing else of the CRM answers. For a host in the <code>ARCHIVE_ROUTE_HOSTS</code> var (with a matching Worker route) the Cloudflare route is set up automatically on deploy: save the address, then <strong>Test connection</strong>. If the CRM can't reach the address itself, Test connection verifies it from your browser instead. Once the test passes you can also send visitors of the CRM's <code>/newsletter</code> to the public address (301).</p>
<p><strong>Other hosts</strong> (a website not on this Cloudflare account): generate a proxy secret (shown once; Rotate replaces it, Remove turns it off) and use the nginx, Vercel or CloudFront snippet to forward <code>/newsletter</code> and <code>/newsletter/*</code> to the CRM with the <code>X-Archive-Proxy-Secret</code> header.</p>`
		},
		{
			id: 'pipeline',
			title: 'Pipeline',
			routes: ['/pipeline'],
			body: `<p>A board of deals: each contact can have <strong>one card</strong>, sitting in one stage. Open stages are the columns; <strong>Won</strong> and <strong>Lost</strong> sit at the end as compact columns (Show to expand).</p>
<p><strong>Drag</strong> a card to another column or up/down within one. The card's ${iconSvg('more', 16)} menu does the same from the keyboard or a phone: Move to…, Mark won / lost, Edit (value, owner, note), Remove, Open contact.</p>
<p><strong>List</strong> view is a sortable table with an inline stage picker — phones open on it. Your Board/List choice is remembered. Filter by owner or search name, email or company.</p>
<p>Every add, move and removal is logged; the contact page's <strong>Pipeline</strong> card shows the stage and the last 5 changes. Admins edit stages from the ${iconSvg('settings', 16)} on the board (rename, colour, reorder, won/lost, delete — cards in a deleted stage move to the stage you pick).</p>`
		},
		{
			id: 'automations',
			title: 'Automations',
			routes: ['/automations'],
			body: `<p>A flow of steps on a canvas: use <strong>＋</strong> on a connector to add an <strong>Email</strong>, <strong>Tag</strong>, <strong>Condition</strong>, <strong>Wait</strong>, <strong>Action</strong> or <strong>End</strong> step. The wait before a step is the small ${iconSvg('wait', 16)} node above it — click it to change it.</p>
<p>Triggers: <strong>Manual</strong> (Enroll contacts), <strong>added to a list/segment/tag/company</strong> (a rule-based segment is checked every heartbeat: contacts who newly match are enrolled; the ones already in it when you activate are not, unless you tick the offer in the activate confirm), a company metric crossing a threshold (checked after each Timing / GitHub / Zoho Books sync — e.g. <em>Overdue balance crosses above 1000</em>; for <em>no payment in 60 days</em> use a Condition rule <em>Company metric · Last payment · more than 60 days ago</em>),<strong>visits a page</strong> (path contains / equals / matches <code>/blog/*</code>, with a cooldown), or <strong>enters a pipeline stage</strong> (any card move into it, except by this automation's own steps), <strong>opens an email</strong> or <strong>clicks a link in an email</strong> (any email or a specific broadcast / email step, optionally only for contacts in a list; for clicks any link or one that contains / equals / starts with a pattern). Add conditions like <em>email is not “Spring promo”</em> or <em>link does not contain “unsubscribe”</em> to stack them. Apple Mail auto-opens are ignored unless you untick it, and by default it fires once per email per contact.</p>
<p><strong>Visits the site often</strong> enrolls a contact once their tracked activity in a rolling window reaches a number you set: <em>pages viewed</em> or <em>separate visits</em> (a visit is a run of pageviews less than 30 minutes apart), on any site or one, optionally only pages whose path matches. Site events are kept for 180 days, so the window is at most 180 days. A cooldown (default one week) stops a heavy browser from re-triggering on every page.</p>
<p><strong>Subscription changes</strong> enrolls a contact when they unsubscribe (optionally only from the unsubscribe link, the preference page, in the app, the API or Postmark), resubscribe, hard-bounce, mark an email as spam, or opt out of / in to a topic (any topic or one). It runs for unsubscribed contacts too, but <strong>email steps are skipped for them</strong>: reaching one ends their pass. Use tags, pipeline moves or other automations in these flows.</p>
<p><strong>Form submitted</strong> enrolls a contact when they submit a chosen form, or any form, optionally only when the answers match (e.g. <em>Budget is Big</em>). Only forms with <em>Enrol in automations</em> on start automations, and anonymous submissions never enrol. Someone who has to confirm first (Double opt-in, or a Consent question that resubscribes them) enrols once they confirm, not before; if they never confirm, nothing starts. In a Condition step, <strong>Answer to a form question</strong> checks one answer: the submission that started this pass, or else the contact's latest submission to that form.</p>
<p><strong>Score changes</strong> enrolls a contact when one of their scores (Settings → Scoring) <em>rises to</em> or <em>drops below</em> a value, <em>enters a band</em> (e.g. Sales-ready), or changes at all. It fires once, when the score actually moves across the line — checked on the next heartbeat after the score is recomputed — not again while it stays there.</p>
<p><strong>Conditions</strong> in the trigger editor (all must hold) come in two groups. <strong>About this event</strong> holds the trigger's own conditions, like <em>email is not…</em> or <em>link does not contain…</em>. <strong>About the contact</strong> works with every trigger: subscription status, topic opt-out / opt-in, bounced or complained, engagement tier, opens, tags, lists, custom fields, company and company metrics, pipeline stage, when the contact was created and their source. They're checked when the trigger fires, and a contact who doesn't match isn't enrolled. A manual enroll shows how many don't match and lets you ignore the contact conditions for that enroll.</p>
<p><strong>Conditions</strong> split the flow into YES and NO lanes that re-join below. A condition is a set of rules (tags, fields, lists, opened / clicked an earlier email, site activity, pipeline stage…) or an <strong>A/B split</strong> that sends a random share down YES. The wait above a condition runs <em>before</em> the rules are checked, so put one there when a rule looks at engagement. To stop someone, put an End step in their lane.</p>
<p><strong>Wait steps</strong> start by asking what the contact will wait for. <strong>A set period of time</strong> (the default, 1 day) waits minutes, hours, days or weeks, optionally moving a weekend end to Monday at the same time. <strong>Until a day or time</strong> waits for the next weekday (or a given day) at a time, or a fixed date. <strong>Until they do something</strong> waits for them to open or click the email before the wait (named in the editor), reply or visit a page, up to a timeout, with a <em>Did it</em> and a <em>Timed out</em> lane; opens and clicks are only offered when an email comes before the wait, and a contact who got no email in this pass goes down <em>Timed out</em> at once. <strong>Only inside a send window</strong> holds contacts until, say, weekdays 9:00 to 17:00. <strong>Until a date field matches</strong> waits for a contact's Date custom field — on it, or a number of hours, days or weeks before or after it, at a time you pick; if the date has already passed (or the field is empty) the contact either continues or leaves the automation, and a changed date moves the wait. <strong>Until specific conditions are met</strong> uses the same rule builder as a Condition step (for example “tag is customer” or “score is at least 50”), checked every few minutes: a contact who matches goes down <em>Did it</em>; tick <strong>Set a time limit</strong> to send the rest down <em>Timed out</em> after a time limit, otherwise a contact who never matches waits there for good. Use <strong>Back</strong> to change the kind (a wait with steps in its lanes can only switch between the two kinds with lanes until they're emptied). Times are in Settings → Timezone.</p>
<p><strong>Action steps</strong> start or end another automation (or all others), <strong>go to a step</strong> in this one (loops stop after 25 jumps), move / remove the contact's pipeline card, or <strong>set the engagement tier</strong> (Hot, Warm, Cool, Cold, Never engaged or New — until cleared or for N days — or back to automatic). The automatic score keeps computing underneath; an override set here wins even over an unsubscribed contact's automatic <em>cold</em>. <strong>Adjust score</strong> adds (or takes away) points on one of the contact's scores, optionally expiring after N days; it shows in their score history as <em>Set by an automation</em>, e.g. “Adjusted Email interest by +5”.</p>
<p>Reorder with the ${iconSvg('drag-handle', 16)} handle (mouse or touch) or ↑ / ↓, in the main flow and inside lanes. <strong>Duplicate</strong> copies a step, or a condition with both lanes. Deleting asks first and offers <strong>Undo</strong> for 10 seconds. Editing is safe while contacts are mid-flow: each continues from the step it waits on, and deleting a step moves its waiting contacts on.</p>
<p>In an email step, <strong>Send test</strong> mails the current draft to you (with the real unsubscribe headers) and <strong>Run checks</strong> shows the pre-send checks. A step added with ＋ starts unfinished (no subject, tag or target yet) — open it and save it before you activate.</p>
<p><strong>Automation tags</strong> organise the automations themselves: use <strong>+ Tag</strong> next to an automation's name (or tick rows on the Automations page and use <strong>Add tag</strong>). They don't touch contacts — a <em>contact</em> tag is what Tag steps, “added to tag” triggers and conditions use. On the Automations page, click a tag (or pick one from the tag search when there are many) to show only those automations; the filter is in the URL (<code>?tag=…</code>), so you can bookmark it.</p>
<p>Opens and clicks are a direct trigger now (above). Email steps — and broadcast campaigns — can still auto-tag contacts who <strong>open</strong> or <strong>click</strong>; those tags fire “added to tag” triggers too.</p>
<p>The <strong>Performance</strong> tab shows the per-step funnel; the <strong>Enrollment inspector</strong> searches every enrollment (50 per page) and can <strong>Retry all failed</strong>. The dashboard warns if the heartbeat stops ticking or enrollments go overdue.</p>`
		},
		{
			id: 'webhooks',
			title: 'Webhooks & website forms',
			routes: ['/settings/webhooks'],
			body: `<p>Settings → <strong>Webhooks</strong> (admins only): create a key per form/integration — each gets a paste-ready URL for any form tool (WS Form etc.). POST <code>email</code> (required) plus optional <code>name</code>, <code>first_name</code>/<code>last_name</code>, <code>company</code>, <code>list</code>, <code>source</code>, <code>tags</code> — JSON or normal form post.</p>
<p>Per-key defaults: contacts arriving through a key get its list + tags (both fire automation triggers). The payload can also send its own <code>tags</code> (e.g. <code>["hot"]</code> from a triage step).</p>
<p><strong>Require confirmation</strong> on a key (or <code>confirm: true</code> in the payload) turns on double opt-in for it: a new address gets one confirm email and only joins the list and tags after confirming.</p>
<p><strong>Recent activity</strong> logs every request — click a row for the raw payload. Extra payload fields (tier, score, details…) are saved on the contact as custom fields.</p>
<p>Spam protection: honeypot field <code>website</code> (never name a real field that), address hygiene: disposable and no-MX domains are accepted but tagged <code>hygiene:invalid</code> (no-MX also <code>unverified-domain</code>).</p>`
		},
		{
			id: 'integrations',
			title: 'Integrations (Timing, GitHub)',
			routes: ['/settings/integrations'],
			body: `<p>Settings → <strong>Integrations</strong> (admins only) connects outside services. Paste a token with <strong>Set token</strong> — it's stored encrypted and only its last 4 characters are shown. A Worker secret (<code>TIMING_API_TOKEN</code> / <code>GITHUB_TOKEN</code>) is the fallback; <strong>Remove</strong> goes back to it. In-app tokens need the <code>MAIL_TOKEN_KEY</code> secret. Each card's <strong>What token do I need?</strong> says which token to create — GitHub needs <strong>Issues: Read-only</strong> on a fine-grained token owned by the repos' org (or a classic token with <code>repo</code>).</p>
<p><strong>Test connection</strong> makes one live call: <em>Connected</em>, or <em>Token set but rejected</em> when the service refuses the token. <strong>Sync now</strong> runs a sync immediately; the heartbeat also syncs each connected service at most every 6 hours.</p>
<p>The <strong>Sync log</strong> keeps the last 20 runs — click one for its counts and any errors. A failed sync is just logged; nothing else stops.</p>`
		},
		{
			id: 'tracking',
			title: 'Site tracking',
			routes: ['/settings/tracking'],
			body: `<p>Settings → <strong>Tracking</strong> (admins only) records page views and events on your own websites — for <strong>known contacts only</strong>. Anonymous visitors are never stored.</p>
<p><strong>Setup:</strong> add a site, click <strong>Install</strong>, paste the <code>&lt;script&gt;</code> tag into the site's head (WordPress: WPCode → Header). Then <strong>Check status</strong> — it shows <em>Receiving</em> once events arrive.</p>
<p><strong>How visitors become known:</strong> with <em>Decorate email links</em> on, links in your emails to a tracking site carry a short signed code; the snippet swaps it for an id kept in the site's own storage. A form posted to a webhook with <code>site_key</code> returns a <code>dsv_id</code> for <code>dsv.identify()</code>.</p>
<p><strong>Server-side events</strong> (orders, bookings): your server posts <code>{ email, name, props }</code> to <code>/api/track/server</code> with a read/write API key from Settings → API (admins create keys). Only existing contacts are matched — it never creates one. Use them in automation conditions and segments like any other event.</p>
<p><strong>Privacy:</strong> Do Not Track, Global Privacy Control, <code>dsv.optOut()</code>, and <code>window.dsvConsent = false</code> all stop tracking. Suggested privacy-policy wording:</p>
<blockquote>When you click a link in an email from us, or submit a form on this site, we may record the pages you visit here and connect them to your contact record, so we can send you more relevant information. We don't track visitors we don't know, and we respect Do Not Track and Global Privacy Control signals. You can opt out at any time with the “Opt out of site tracking” link on this page, or by emailing us.</blockquote>`
		},
		{
			id: 'contacts',
			title: 'Contacts & custom fields',
			routes: ['/contacts', '/settings/custom-fields'],
			body: `<p>Click a contact's email to open their record: edit details (email edits are collision-checked), tags, custom fields, full send/open/click history, and captured replies.</p>
<p><strong>What emails has a contact been sent?</strong> Open their page and scroll to <strong>Conversations</strong> at the bottom: it lists every email sent to them (broadcasts, automation emails, 1:1 emails) with their replies — <strong>View email</strong> opens the exact message they got. <strong>Engagement</strong> counts the emails sent to them and their opens, clicks and replies; <strong>Activity</strong> is the event log (delivered, opened, clicked, bounced) with a link to each email. The <strong>Conversations</strong> page in the nav is different: it only lists a broadcast or automation email once the contact replies to it, so use the contact page for their full send history.</p>
<p>Click the <strong>Subscribed</strong> / <strong>Unsubscribed</strong> badge on a contact's page to change it; unsubscribing asks for a reason and can also suppress the address in Postmark. A contact waiting on double opt-in shows <strong>Pending confirmation</strong> there instead, and its menu offers <strong>Resend confirmation</strong> and <strong>Cancel confirmation</strong> (to subscribe them without confirming, cancel first, then pick <strong>Subscribed</strong>).</p>
<p><strong>Unsubscribe someone yourself:</strong> on their page, click <strong>Unsubscribe</strong> next to Edit and Archive (it reads <strong>Resubscribe</strong> once they're unsubscribed), pick a reason and save. For many at once, tick them on the Contacts list and use <strong>Unsubscribe</strong> or <strong>Resubscribe</strong> at the top of the bar, next to the selection count. <strong>Also suppress in Postmark</strong> (on by default) also adds the address to Postmark's suppression list, so nothing reaches it even if it's sent to by mistake; leave it off to only mark them unsubscribed here.</p>
<p><strong>Custom fields</strong> hold anything — webhook payloads add theirs automatically; you can add/edit/remove by hand. Use them in emails via <code>{{field:name}}</code> and conditionals. Only fields this contact has a value for are listed: fields defined in <strong>Settings → Custom fields</strong> first, in their order, with their label and the right input (a number, a date, Yes / No, or a list of choices), then other keys. <strong>+ Add field</strong> offers the defined fields this contact has no value for (pick one by name, then enter its value), or type a new field name. Clearing a defined field's value removes it from the contact.</p>
<p><strong>Settings → Custom fields</strong> (admins) lists every defined field with its key, type, how many contacts have a value and which forms fill it. Create a field (label, optional key, type, choices), edit its label, type or choices, reorder it, or <strong>Archive</strong> it: it disappears from pickers, but contact values are never removed (Restore brings it back). The key can't change — the API, webhooks, CSV import and <code>{{field:key}}</code> use it. <em>Found on contacts, not defined</em> lists keys stored on contacts that have no definition yet; <strong>Define</strong> names one. Fields the app writes itself (hygiene, phone) are marked built in and can't be archived or retyped; forms can't fill hygiene (the address check owns it). Up to 200 fields can be active at once; archived ones don't count, so archiving a field you no longer use frees a slot. Segment and automation rules on a custom field pick it by name, and a choice or yes / no field offers its values.</p>
<p><strong>Scores</strong> (under Engagement on the contact page): each active score from Settings → Scoring with its value, band and when it last changed. <strong>History</strong> lists the last 20 point entries — why, from what, when earned and when they expire. Admins can <strong>Adjust</strong> a score by hand (± points, optional expiry, a note).</p>
<p><strong>Automations</strong> on a contact's page: pick an active automation and <strong>Enroll</strong>. When they aren't enrolled, it says why: they're archived, unsubscribed, already going through it, already went through an automation that only takes each contact once, or they don't match its contact conditions. Each has a way past it: once only offers <strong>Enroll again</strong>, a run in progress offers <strong>Restart from the first step</strong> (ends the current run, starts a new one at step 1), and the contact conditions offer <strong>Enroll anyway</strong>. Unsubscribed or archived contacts are never enrolled; resubscribe or restore them first. The same overrides are in an automation's <strong>Enroll contacts</strong> dialog for contacts you pick one by one: it lists each skipped contact with the reason, with <strong>Enroll again</strong> or <strong>Restart from the first step</strong> to tick where they apply. Enrolling a list or segment has no overrides.</p>
<p><strong>Ratings</strong> (under Scores, only when there are any): every rating the contact gave through a form's Rating question, newest first — the value out of the highest in its style, the question, the form and the date. Ratings stay after the form's submissions are removed and are deleted with the contact.</p>
<p>On the list, ${iconSvg('settings', 16)} → <strong>Score</strong> adds a column with one score's value and band (pick which score there; the heading sorts by it). <strong>Filters → Score</strong> (≥, &gt;, ≤, &lt;, = or between) and <strong>Score band</strong> narrow the list, and segments and automation conditions have the same <em>Score value</em> / <em>Score band</em> rules. Admins get <strong>Adjust score</strong> in the bulk bar (± points, expiry, note for every checked contact).</p>
<p>Table: click headings to sort; ${iconSvg('settings', 16)} picks visible columns (saved per browser). <strong>Export CSV</strong> is your backup — everything including memberships and custom fields.</p>
<p><strong>Finding contacts:</strong> the search box matches email, name and company (the company text and the linked company's name). <strong>Lists &amp; tags</strong> next to it opens a searchable menu of your lists, segments and tags with member counts: pick one to show its contacts, or use the ${iconSvg('external', 16)} at the end of a row to open that group's own page; <em>All lists</em>, <em>All segments</em> and <em>All tags</em> at the bottom open the management pages. Live segments open their own page. The <strong>Active · Subscribed · Pending · Unsubscribed · All</strong> pills filter by status.</p>
<p><strong>Unsubscribed and archived contacts are hidden.</strong> Lists, tags, segments, companies, reports, search, pickers, the API's contact list and every “N contacts” count show only <em>active</em> contacts: subscribed, or waiting on double opt-in (pending), and not archived. The only place to find the others is this page: the <strong>Unsubscribed</strong> or <strong>All</strong> pill, or the <strong>Archived</strong> view (its Status column reads <em>Archived</em>). The line above the table says how many the current search and filters hide, with links. A contact's own page still opens from a direct link and shows their status, so you can resubscribe or restore them there. A live segment whose rules ask about subscription (<em>Subscribed is no</em>) still shows the unsubscribed people it matches. Past campaign stats (sent, opened, clicked) are history and still count everyone they were sent to.</p>
<p><strong>Filters</strong> groups everything else into sections — <em>People</em>, <em>Engagement</em>, <em>Deliverability</em>, <em>Website</em>, <em>Pipeline and company data</em> — one open at a time, each heading showing how many of its filters are on. Type in <strong>Find a filter</strong> to jump to a control by name. On a phone the panel opens as a full-width sheet with Apply and Clear at the bottom. Every active filter shows as a chip under the toolbar; click its × to remove just that one, or <strong>Clear all</strong>.</p>
<p><strong>Filters → Pipeline and company data → Company metrics</strong> narrow the list by the contact's company: Timing hours, GitHub issues and — with billing access — Zoho Books balances and payment dates (e.g. <em>Overdue balance &gt; 0</em>). Contacts without a company never match.</p>
<p><strong>Overview</strong> (top of the page, collapse it with its heading): tiles, growth, by source / by list, engagement mix, <em>Needs attention</em>, your groups and an activity feed — all for the contacts the current search and filters match (archived ones only in the Archived view). Pick <strong>7d · 30d · 90d · 12m</strong> for the period. Every tile and row is a link that applies its filter to the table, so the number you clicked is the number you get. The feed can show chosen types only, just this period, or <strong>group by contact</strong>; <strong>Export feed CSV</strong> downloads up to 5,000 rows. <strong>Save as segment</strong> keeps the view (live when the filter can be segment rules, else a snapshot); <strong>Create report</strong> opens the report builder with the filter.</p>`
		},
		{
			id: 'companies',
			title: 'Companies',
			routes: ['/companies'],
			body: `<p>The <strong>overview strip</strong> at the top covers every company (not your search): how many there are and how many are connected, <strong>Active 30d</strong> and <strong>Going quiet</strong> (Timing hours in 90 days but none in 30), <strong>Open issues</strong> (GitHub), and — with billing access — <strong>Outstanding</strong> and <strong>Invoiced 12m</strong> (Zoho Books). A tile only shows once its source has synced. Click a tile to filter the table.</p>
<p><strong>Filters</strong>: All · Active 30d · Going quiet · Open issues · Overdue · Not linked (no Timing project, GitHub repo or Zoho customer). They combine with the search and each opens with a useful sort.</p>
<p>Columns: Hours 30d (with 7 days under it), Open issues (opened / closed in 30 days), <strong>Outstanding</strong> (Zoho balance, overdue in amber — only for admins, or members when Settings → Integrations allows billing), and <strong>Last touch</strong>: the newest of the last email open / click, Timing entry and GitHub issue activity; the ${iconSvg('mail', 16)} ${iconSvg('timing', 16)} ${iconSvg('github', 16)} icon says which.</p>
<p><strong>A company's page</strong> is its dashboard: the at-a-glance tiles, then two columns — the engagement trend and the <strong>Timeline</strong> (filter it by source with the chips) on the left; the account brief, top engaged contacts and compact panels on the right: <strong>Open deals</strong> (stage, value, days in stage), <strong>Conversations</strong> from the last 90 days (awaiting our reply first), <strong>Timing</strong> hours with a 12-week sparkline, <strong>GitHub</strong> counts and recent issues, and ${iconSvg('billing', 16)} <strong>Billing</strong> (only with billing access). A panel only shows once its source has data. Below them: the contacts table and the company <strong>Notes</strong> (collapsed; open it to edit).</p>
<p>To connect a company, use <strong>Manage integrations</strong> at the bottom of its page: attach or detach a Timing project, add or remove GitHub repos, sync each, and — once Zoho Books is connected in Settings → Integrations — link or unlink Zoho customers. The Zoho search matches on customer name, company name or email domain; linking pulls that customer's invoices and payments right away. The full invoice and payment tables are folded up in the same card.</p>
<p><strong>Company metrics</strong> follow the contacts linked to a company: the Contacts <strong>Filters</strong> popover, segment rules, automation Condition rules and the <em>Company metric crosses</em> trigger can use them, and <code>{{company.&lt;key&gt;}}</code> merge tags print them. <strong>Timing</strong>: hours tracked (7 / 30 / 90 days, all time), last time tracked. <strong>GitHub</strong>: open issues, issues opened / closed in 30 days, closed issues (all time), last issue activity. <strong>Billing</strong> (Zoho Books): outstanding and overdue balance, invoiced and paid in 12 months, last payment, last invoice — money prints in the company's currency, e.g. <code>{{company.ar_overdue}}</code>. Billing metrics are only offered to people who may see billing; anyone else sees a saved one as “Billing metric (admin-only)”.</p>`
		},
		{
			id: 'groups',
			title: 'Lists, segments, tags & companies',
			routes: ['/groups', '/lists'],
			body: `<p>All grouping kinds share one system: <strong>Lists</strong> (audiences you send to), <strong>Segments</strong> (hand-picked subsets), <strong>Tags</strong> (labels — and automation triggers), <strong>Companies</strong> (derived automatically from each contact's company field).</p>
<p>Create lists/segments/tags with the <strong>+</strong> on their boxes. Companies can't be hand-created — set a contact's company instead.</p>
<p><strong>Members and counts are active contacts only</strong> (subscribed or pending, not archived); the header says how many unsubscribed and how many archived members it hides (an archived contact counts as archived even if it also unsubscribed), each with a link to them on the Contacts page. The CSV export leaves them out too. Sends and enrolment never reach unsubscribed or archived contacts, nor pending ones until they confirm.</p>
<p>Every group has a <strong>description</strong> and an <strong>origin/consent note</strong> (Edit details on the group page). The origin is shown to recipients — in the email footer (“You're receiving this because…”) and on the unsubscribe page — so write it for them.</p>
<p><strong>Preference center:</strong> mark a list as a <em>subscription topic</em> (Edit details on a list) and give it a <strong>public label</strong> and short description — that's all subscribers see, never the list's name. Topics appear on the unsubscribe/preference page so recipients can opt in/out per topic instead of all-or-nothing — fewer full unsubscribes. An opt-out holds: emails for that topic skip them, whichever list or segment they're sent to.</p>
<p><strong>Archive a list or segment</strong> (admins): select it on the Lists or Segments page and choose <strong>Archive</strong>, or use Archive on its own page. It disappears from pickers (compose, automations, rule builders, imports, forms, the contacts filters) and from the Active view; members, campaign history and reports stay as they were. Something that already uses it keeps showing it as “(archived)”. It can't be archived while it's a public topic, the audience of a scheduled or sending campaign, or the trigger of an active automation. Find it again under <strong>Archived</strong> and choose <strong>Restore</strong>.</p>`
		},
		{
			id: 'replies',
			title: 'Reply capture',
			routes: ['/campaign', '/conversations'],
			body: `<p>Replies to app-sent emails are captured via Postmark Inbound: stored on the contact + campaign pages, and a copy is forwarded to your inbox with Reply-To set to the sender — answer directly from your mail client.</p>
<p><strong>Conversations</strong> threads each send with the replies it got (direct 1:1 emails thread by subject, Re:/Fwd: ignored, within 30 days). <em>Awaiting my reply</em> = the last message is theirs. Inside a thread each message is indented under the one it answers, with a line back to it; past four levels it says whom it is replying to.</p>
<p><strong>Gmail</strong> (Settings → Mail): synced mail with contacts shows on their contact page. Each teammate connects their own Google mailbox there; mail sent from a mailbox nobody connected isn't seen. A reply you send from a connected mailbox — in Gmail, Apple Mail, Outlook or on your phone, also when you answer the “via” forward of a contact's reply — joins the conversation it answers, shows who sent it (“replied from Gmail”) and clears <em>Awaiting my reply</em> everywhere. Threads made only of Gmail mail join the Conversations list only when <em>Show Gmail threads in Conversations</em> is on — then a <em>Gmail</em> tab shows them alone. Mail between your own people (your internal domains, users, connected mailboxes) and automated mail (receipts, newsletters, notifications, no-reply senders, auto-replies) never makes a conversation.</p>
<p>Tick conversations (shift-click for a range, <kbd>x</kbd> toggles the focused row) and <strong>Archive</strong> the ones that don't need attention — they move to the <em>Archived</em> tab (Unarchive brings them back), and a new reply brings one back on its own. Admins can also <strong>Delete</strong>: the replies and the Gmail messages you received go for good (Gmail won't re-import them); your sends — campaign emails and mail you sent from Gmail — stay in history and stats, only hidden here (also after a Gmail re-sync). Both are also on a thread's own page.</p>
<p><strong>Draft reply</strong> (when the assistant is on for you): pick a tone, optionally add a one-line instruction, and the assistant writes a draft into the Reply box from this thread and this contact's record. Shorter / Longer / More formal / Translate to Spanish adjust it. It never sends: you edit the draft and click Send reply. Anything marked [check this] needs checking.</p>`
		},
		{
			id: 'pages',
			title: 'Hosted pages',
			routes: ['/pages'],
			body: `<p>Block-built pages served publicly at <code>/p/&lt;slug&gt;</code> once published (drafts 404). Use them for “how you got on this list” explainers, link them from email footers or the origin note.</p>
<p><strong>Save</strong> and <strong>Publish</strong> are separate: Publish flips visibility, Save commits block edits. Published pages cache ~5 minutes.</p>`
		},
		{
			id: 'forms',
			title: 'Forms',
			routes: ['/forms', '/f'],
			body: `<p>A <strong>form</strong> is a page people fill in — a sign-up, a booking request, feedback. Published forms live at <code>/f/&lt;slug&gt;</code>; drafts and archived forms 404. Creative → Forms lists them; admins create and edit, everyone can read submissions.</p>
<p><strong>Questions</strong>: click a card to edit it — the question, its type, options (Enter adds the next one, Backspace on an empty one removes it), help text, Required. Drag the handle or use the arrows to reorder. The add rail next to the open card adds a question, heading, paragraph or page break. Everything is kept until you click <strong>Save</strong> (or ${k('Mod+S')}); problems show on the card they belong to.</p>
<p><strong>Maps to</strong> decides where an answer goes on the contact: a contact field (name, company, phone…), a custom field, a tag (the chosen option, or a fixed tag for a tick), tags with a prefix, a list or a topic. “Answer only” keeps it on the submission. Every form needs an Email question mapped to the contact email, unless <em>Allow anonymous submissions</em> is on in Settings.</p>
<p><strong>Mapping to a custom field</strong>: choose <em>Custom field</em>, then pick a field by its name. To make a new one without leaving the question, pick <strong>Create new field…</strong>: the label comes from the question, the key is made from it, and the type is suggested from the question (Number and Rating → number, Date → date, a single checkbox or Consent → yes / no, Dropdown and Multiple choice → choice with the question's options). Change any of it, then <strong>Create field</strong> — the field is saved straight away (admins only). A form that maps to a key nobody has defined yet keeps working and says “not defined yet”, with <strong>Define it</strong> to name it in one click. Settings → <em>Add to</em> → <strong>Set fields</strong> gives every submission a fixed value in a field, with the same picker.</p>
<p>A submission creates the contact (subscribed, with your source) or updates the existing one — a blank answer never clears a field. Someone who unsubscribed stays unsubscribed. If the form has a <strong>Consent</strong> question they tick, they get a confirm email (unless Postmark has blocked them for a bounce or spam) and are only resubscribed — and given the form's lists, tags and fields — once they confirm, even with Double opt-in off. Settings → <em>After submit</em> shows a message or goes to a web address; <em>Add to</em> adds lists, tags and the source; <em>Enrol in automations</em> lets list adds start list-triggered automations (tags always do) and lets submissions start <strong>Form submitted</strong> automations. <em>Notify</em> emails the people you pick on each submission. With <em>Double opt-in</em> on, an address that isn't subscribed yet gets a confirm email instead and shows as <strong>Pending confirmation</strong>; the form's lists, tags, topics and fields apply only once they confirm.</p>
<p><strong>Rating</strong> questions (add rail or the <em>Rating</em> button) ask for a score: pick <strong>Stars</strong> or <strong>Hearts</strong> (1 to 5 or 1 to 10), <strong>Faces</strong> (1 to 5) or a <strong>Number scale</strong> (1 to 5, 1 to 10 or 0 to 10), and optional words for each end such as “Not likely” and “Very likely”. People pick with a click, a tap or the arrow keys; it works without script, so it also works in the newsletter archive's sign-up popup. When the person is a contact, the rating is saved on their record (the <strong>Ratings</strong> card) with the question, the form and the date, and stays there after the submission is removed. Map it to a custom field to use the latest number in segments, scores and automations. The submissions list shows it as “4 / 5”; the CSV has the number. Outcome rules can read it as a number (“is at most 3”).</p>
<p><strong>Style</strong>: start from a preset (Feedback page looks like the unsubscribe page) and adjust colours, width, corners and font with a live preview. <strong>Submissions</strong>: filter, Export CSV (newest 5,000), delete. Spam (a hidden trap field) and rejected posts sit under <em>Spam &amp; rejected</em>. Submissions are kept for the days set in Settings (365 by default), then removed overnight. One visitor can send 10 in 10 minutes.</p>
<p><strong>Automations</strong> (Settings tab): lists the automations this form starts, with their status. <strong>Create automation</strong> makes a draft with the <em>Form submitted</em> trigger set to this form and opens it; activate it on the automation page when it is ready.</p>
<p>On a contact, the <strong>Forms</strong> card lists their submissions, newest first: form, date, status and the answers (click to expand), with a link to their submissions on that form. On Contacts, <strong>Filters → Submitted form</strong> finds people who sent any form or one form, optionally in the last N days; segments have the same rule (<em>Submitted form</em> under Forms).</p>
<p><strong>Scoring</strong> (Settings tab, admins): the score rules a submission of this form earns points from — the score, the points and any answer conditions in words, including rules that count any CRM form. <strong>Add a score rule</strong> opens Settings → Scoring with this form picked: choose the score and the new rule starts on this form.</p>
<p><strong>Webhook</strong> (Settings tab → Notify): an optional <code>https://</code> address that gets a JSON POST on every accepted submission (not spam or rejected ones): <code>form</code> (id, name, slug), <code>submission_id</code>, <code>contact_id</code>, <code>email</code>, <code>answers</code>, <code>submitted_at</code> and <code>page_url</code> (the page it was sent from). Each POST carries <code>X-DSV-Signature: t=&lt;unix time&gt;,v1=&lt;signature&gt;</code>, where the signature is the hex HMAC-SHA256 of <code>&lt;t&gt;.&lt;body&gt;</code> with the form's signing key, shown to admins under the address. It is sent once, waits at most 5 seconds and never delays the person submitting; if it fails, the submission's detail says so. Local and private network addresses are refused.</p>
<p><strong>With the assistant</strong>: ask it to draft a form ("a booking request that asks for the budget only when they pick a project"). It shows the questions and logic on a card; after you press Approve the form is a draft here, ready to review and publish. It can also change a draft form (a published one must be unpublished or duplicated first) and summarise submissions. It never publishes, archives or deletes a form, or sets allowed origins or the webhook. Undo on its card removes a draft it made (while untouched and without submissions) or puts back the version before its change.</p>
<p><strong>Reading forms from other tools</strong>: with a Data API key (Settings → API), <code>GET /api/v1/forms</code> lists forms and <code>GET /api/v1/forms/&lt;id&gt;/submissions?since=&amp;limit=</code> returns accepted submissions, newest first, up to 200 a page. The MCP server has the same as <code>list_forms</code> and <code>get_form_submissions</code>, and the <code>dscrm</code> CLI as <code>forms list</code> and <code>forms submissions &lt;id&gt;</code>. All read-only.</p>
<p><strong>Logic</strong> (tab between Questions and Style) has three parts. <strong>Show a question only when…</strong>: give a question conditions on earlier answers (“Role is Manager”, “Budget is at least 500”, match all or any); it appears only while they hold, and an answer to a hidden question is thrown away. <strong>Page jumps</strong>: after a page, send people to a later page — or straight to Submit — when their answers on that page or before it match; the first jump that matches wins, otherwise they go to the next page. Pages they skip are ignored, also when the form is sent without script. <strong>After submit</strong>: rules that add tags, remove tags, add to a list or topic, set a field or the source, enroll in an active automation (only with <em>Enrol in automations</em> on), notify someone, or show their own message or web address — when their conditions hold. Rules can also read what we know about the person when their email matches a contact (<em>Known contact</em>: a tag, a list, a field); for a new or anonymous person those conditions never match. Choose <strong>Run every rule that matches</strong> or <strong>Run only the first rule that matches</strong>; drag or use the arrows to order them. The first matching rule with a message or web address decides what people see; with none, the Settings tab's message or address is used. In <strong>Preview</strong>, <em>Why hidden?</em> lists what your answers hide and which rule hid it.</p>
<p><strong>Share &amp; embed</strong> (tab): copy the <strong>script embed</strong> (a <code>&lt;div&gt;</code> plus one script tag; the form sizes itself to its content, passes the page's <code>utm_*</code> through and records the page it was sent from), a plain <strong>iframe</strong> with a fixed height, the <strong>direct link</strong>, or a <strong>raw HTML</strong> form that posts straight to the CRM (no conditional logic or pages in that mode). <strong>Allowed origins</strong> (one per line, e.g. <code>https://example.com</code>) are the sites the form may be embedded on and submitted from; leave it empty to allow anywhere. Put <code>data-email</code> or <code>data-&lt;answer key&gt;</code> on the <code>&lt;div&gt;</code> to prefill answers. In an email, <code>{{form:&lt;slug&gt;}}</code> is a link to the form signed for each recipient: their email is filled in and hidden, so a one-click survey is credited to them. The link stops prefilling after 30 days.</p>`
		},
		{
			id: 'deliverability',
			title: 'Deliverability & list hygiene',
			routes: ['/deliverability'],
			body: `<p><strong>Deliverability</strong> shows bounce/complaint/unsubscribe rates over the last 90 days and warns when bounce (&gt;5%) or complaints (&gt;0.1%) get risky — high rates hurt your sender reputation with Postmark.</p>
<p><strong>Cold contacts</strong>: subscribed people who haven't opened/clicked in N months. Tag them in one click, then build an automation triggered by that tag to win them back — or stop mailing them.</p>
<p><strong>Suppressed contacts</strong> lists everyone unsubscribed/bounced/complained, with the reason.</p>
<p><strong>Sync from Postmark</strong> copies Postmark's suppression list (hard bounces, spam complaints, manual suppressions) into the CRM. It runs once a day, and once more about 15 minutes after each campaign goes out, so a bounce that slipped past during a large send is caught the same hour. "Last synced" says which run it was: daily, after a send, or manual.</p>
<p><strong>Unsubscribes are custom</strong> on the broadcast stream: Postmark adds no link of its own, so the app's unsubscribe link and List-Unsubscribe headers are the only way out — a broadcast missing them is never sent.</p>`
		},
		{
			id: 'double-optin',
			title: 'Double opt-in',
			routes: ['/settings/double-optin'],
			body: `<p><strong>Double opt-in</strong> is optional and off by default. Turn it on per webhook key (<strong>Require confirmation</strong>), per form, or per API request (<code>confirm: true</code>). A new sign-up then gets one email with a confirm link. They show as <strong>Pending confirmation</strong> and get nothing else until they press <strong>Confirm my subscription</strong> on that page. Only then are they subscribed, added to the lists and tags the sign-up asked for, and entered into automations. Opening the link alone never confirms, because mail scanners open links too.</p>
<p><strong>Settings → Double opt-in</strong> (admins) sets the email (it must contain <code>{{confirm_url}}</code>), the button, the message after confirming and how long a link lasts (24, 48 or 72 hours). An expired link offers <strong>Send a new link</strong>. A confirmation can be re-sent up to 3 times, 10 minutes apart, from that page or from the <strong>Pending confirmation</strong> badge on the contact page (<strong>Resend confirmation</strong> or <strong>Cancel confirmation</strong>). An address that's already subscribed skips the email. For someone who unsubscribed earlier, confirming counts as resubscribing, and it's refused when Postmark suppressed them after a bounce or spam complaint. Filter the contacts list by Status → Pending confirmation.</p>`
		},
		{
			id: 'signature',
			title: 'Email signature',
			routes: ['/settings/signature'],
			body: `<p><strong>Settings → Signature</strong> (admins) sets the signature added under every email that uses the standard layout: broadcasts, automation emails, scheduled sends, 1:1 emails and conversation replies. Leave it empty (or <strong>Remove signature</strong>) and emails end after their content, with no empty space where a signature would be.</p>
<p>Write it as <strong>Simple text</strong> (one line per row, <code>**bold**</code>, <code>*italic*</code>, <code>[label](https://…)</code> links) or switch to <strong>HTML</strong> to paste a signature from your mail app. Pasted HTML is cleaned on save: scripts, frames, forms and event handlers are removed. The <strong>Plain-text version</strong> is used in the text part of each email; leave it empty and it is generated. The preview shows both. A change applies to emails rendered from then on; raw HTML templates and the newsletter archive never show a signature.</p>`
		},
		{
			id: 'unsubscribe-page',
			title: 'Unsubscribe page',
			routes: ['/settings/unsubscribe'],
			body: `<p><strong>Settings → Unsubscribe page</strong> (admins) customizes what people see after clicking unsubscribe in an email: a heading, a Markdown message, a video, and what shows after they unsubscribe (message, a second video, links, an optional <strong>Resubscribe</strong> button). <strong>Preview</strong> shows both states with a sample address.</p>
<p>The address, the <strong>Unsubscribe from everything</strong> button and the topic choices always come first; your text and video come after them (the video below the controls, or beside them on wide screens). Videos never autoplay. Paste a YouTube, Vimeo or Loom link (other links are refused) or upload an MP4/WebM up to 50 MB.</p>
<p>Resubscribe is off by default. It works only from that person's own link, and it's refused for addresses Postmark suppressed after a hard bounce or a spam complaint. One-click unsubscribes from the inbox never see this page.</p>
<p><strong>Topics</strong> lists your subscription topics in the order subscribers see them (drag to reorder), with warnings for topics that look archived, have no public label (hidden from subscribers) or have no members. With one topic the page offers <em>Keep receiving …</em> next to <em>Unsubscribe from everything</em>; with more, checkboxes. Unticking everything unsubscribes them; saving never resubscribes anyone unless they tick <em>Resubscribe me</em>. Choose which topic an email belongs to in Compose → Audience (automations: the trigger panel).</p>`
		},
		{
			id: 'reports',
			title: 'Reports',
			routes: ['/reports'],
			body: `<p><strong>Reports</strong> builds a table, bar, line or summary from contacts, companies, campaigns, segments, pipeline and site pages. Choose columns, filters and a time range; the results update as you edit. The address bar keeps an unsaved spec, so copying the link reproduces the report.</p>
<p><strong>Save</strong> stores it in the library. <strong>Pin to Reports home</strong> adds a preview card on Reports. <strong>Export CSV</strong> downloads the rows for Excel: rates are plain numbers (the % is in the column name), blanks stay blank, and times are in Settings → Timezone, like the table. <strong>Duplicate</strong> opens an unsaved copy in the builder; nothing is saved until you click Save.</p>
<p>Built-in reports are read-only, but each one can be pinned (with its current settings) and exported. Those with a time range also take a <strong>Custom range</strong> (two dates, at most 2 years apart). <strong>Duplicate to customize</strong> is offered only where your copy would be the same report; <strong>Settings this report uses</strong> shows the builder settings behind it.</p>
<p><strong>Scoring reports</strong> (Contacts folder) pick one active score: <strong>Score distribution</strong> counts contacts per band (10-point buckets without bands) with the top 25 by value; <strong>Score movers</strong> lists who went up or down most in 7, 30 or 90 days, with the rule behind most of it; <strong>Score rule activity</strong> shows the points each rule awarded in the range and its share, so you can see which rules do the work.</p>
<p>Hours, billing and pipeline value are for admins. Members aren't offered those columns, and opening a report that uses them shows the engine's refusal. <strong>How these are calculated</strong> lists the definition of each column on the report.</p>`
		},
		{
			id: 'assistant',
			title: 'Using the assistant',
			routes: ['/settings/assistant'],
			body: `<p>Open the AI assistant with the sparkle button in the header (or the round button lower right), or press <strong>${k('Mod+J')}</strong>. Ask in plain words — "how did my last campaign do?", "who clicked but never replied?". It reads the app's data as you, and knows which page you're on (remove the page chip to leave it out).</p>
<p><strong>What it can do:</strong> look things up and summarise; edit contacts, tags, lists, segments, companies and pipeline deals; draft campaigns, draft automations and draft forms; unsubscribe, resubscribe or archive contacts when you ask. Each change shows a card with <strong>Undo</strong>. Bigger changes (more than 25 contacts, unsubscribes, building a whole automation, drafting or changing a form) wait for you to press <strong>Approve</strong>. Deleting contacts and writing code are off unless an admin turns them on.</p>
<p><strong>Ask it to draft a form:</strong> "draft a newsletter sign-up with topics and consent", "an NPS survey that tags promoters and sends them to our review page", "an RSVP that skips the details page when they can't come". It proposes the questions, then shows the form in words on a card (questions, where each answer goes, the logic, the outcomes); press <strong>Approve</strong> and it is saved as a draft with an <strong>Open in builder</strong> link. It can change a draft form the same way, and read forms and their submissions ("how many said yes last week?"). It never publishes, unpublishes, archives or deletes a form, and never sets a form's allowed origins or webhook. The <strong>Forms</strong> skill (Settings → Assistant → Skills) holds its house rules: consent on marketing sign-ups, the email mapped to the contact, under 8 questions, a page break after 5. Edit it like any skill.</p>
<p><strong>What it can't do:</strong> send or schedule email, send tests, activate automations, enroll anyone, publish a form, or edit a sent or scheduled campaign. It never starts an automation. Text inside contacts, replies or subjects is treated as data — it won't follow instructions hidden there.</p>
<p><strong>Access:</strong> admins choose who can use it in Settings → <strong>Assistant</strong> (off, selected people, or everyone). <strong>Skills</strong> there are house instructions it follows (style, campaign strategy, your own). <strong>Scheduled jobs</strong> run a saved prompt on a schedule, read-only, and post the report to a webhook.</p>
<p><strong>Costs and caps:</strong> each answer shows its approximate cost. Spending stops at the monthly cap for the app and the daily cap per person (both in Settings → Assistant, which also shows spend by model, top tools and the average cost per turn). Conversations are deleted after the history period set there (180 days by default).</p>
<p><strong>Feedback:</strong> use the thumbs up / down under an answer — admins see which answers missed.</p>`
		},
		{
			id: 'search',
			title: `Search (${k('Mod+K')})`,
			routes: [],
			body: `<p>Press <strong>${k('Mod+K')}</strong> (or <strong>/</strong> when you're not typing in a field), or use the search button in the header, to find any contact, company, campaign or automation by name, email, domain, subject or automation tag. Results fill in as you type, grouped by type, up to 5 each; <strong>See all</strong> opens the list page with your search filled in.</p>
<p><strong>Keys:</strong> ↑ / ↓ move, <strong>Tab</strong> jumps to the next group, <strong>Enter</strong> opens, <strong>${k('Mod+Enter')}</strong> opens in a new tab, <strong>Esc</strong> closes. Before you type, it lists the records you recently opened from search (kept in this browser only). Archived contacts aren't shown.</p>`
		},
		{
			id: 'scoring',
			title: 'Contact scoring',
			routes: ['/settings/scoring', '/settings/api'],
			body: `<p>A <strong>score</strong> adds up points per contact from rules you write (Settings → <strong>Scoring</strong>, admins). Each contact page shows every active score in its <strong>Scores</strong> card.</p>
<p><strong>Event rules</strong> give points each time something happens: an open (or an automatic Apple Mail open, scored separately), a click (optionally on one campaign, automation or URL), a bounce, a spam complaint, an unsubscribe, a reply, an external form submit (a webhook key), a CRM form submission, a page view or site event, entering a pipeline stage, finishing an automation, or joining a list or tag. A rule can count only the first time, or at most N times a day. Points can be negative.</p>
<p><strong>Submitted a CRM form</strong> counts submissions of the forms built here (Creative → Forms) that added or updated a contact — anonymous, spam and rejected ones earn nothing. Pick one form or leave it on any form. With one form picked, add <strong>answer conditions</strong>: a question, a comparison and a value (“Your role is Owner”, “How likely is at least 8”); choice questions list their options, number and rating questions compare numbers. Match all or any of them, up to 10. A new CRM form rule only counts submissions made after you add it, also on Rebuild. The contact's score history names the form and links to it.</p><p> <strong>Condition rules</strong> use the segment rule builder and hold their points while the contact matches (checked when you save and once a day).</p>
<p><strong>Decay</strong>: <em>points expire per rule</em> (each event rule sets its own expiry, blank = permanent), <em>half-life</em> (every point fades — half after N days, a quarter after 2N), or <em>permanent</em>. <strong>Bands</strong> name ranges (e.g. Hot from 50); a value below the lowest band has none.</p>
<p>New rules score new activity. <strong>Rebuild</strong> clears a score's earned points and replays the last 365 days through its current rules over the next heartbeat ticks (manual adjustments stay). Two defaults come built in: <strong>Lead score</strong> (opens, clicks, replies, forms, site visits and pipeline moves, minus unsubscribes and spam) and <strong>Likely to churn</strong> (a Cold tier, no opens in 60 days, bounces and unsubscribes, pulled down by clicks and replies).</p>
<p><strong>Data API</strong> (Settings → API, admins manage the keys): <code>GET /api/v1/scores</code> lists the scores with their bands; <code>GET /api/v1/contacts/:id/scores</code> gives one contact's values, bands and last 20 point entries; every contact in the API carries <code>scores</code>. With a read/write key, <code>POST /api/v1/contacts/:id/scores/:scoreId/adjust</code> <code>{ points, expires_days?, note? }</code> adds a manual entry. The assistant and the MCP server can list scores, read a contact's scores and the top contacts by a score; the assistant can also add points.</p>
<p><strong>Engagement</strong> (the hot / warm / cool / cold tier) is separate: weighted opens, clicks, replies and site activity, each halving after the half-life, squashed onto 0–100 and cut at the tier thresholds — tuned by admins in Settings → General → Engagement.</p>`
		},
		{
			id: 'segments',
			title: 'Dynamic segments',
			routes: [],
			body: `<p>On a segment's page, add <strong>rules</strong> to make it auto-update. The rule picker is grouped: Subscription (subscribed or not, opted out of / in to a topic, bounced, marked as spam), Engagement (tier, opened in the last N days, never opened, site visits), Groups (tag, list), Fields (custom field exists / equals / contains), Company (company, company metrics), Pipeline (stage, no deal) and Contact (created within N days, source) — matched ALL or ANY. The membership recomputes live everywhere it's used (compose, enroll, counts). Save with no rules to go back to hand-picked.</p>
<p>A dynamic segment has no members to remove — the rules decide who is in. To take someone out anyway, check them on the segment's page and pick <strong>Exclude from this segment</strong> in the bulk bar: they get a tag named <em>excluded: (segment name)</em> and the segment gets a rule that skips that tag. Remove the tag from a contact to let them back in.</p>
<p>In the bulk bar's <strong>Add to segment</strong> picker, dynamic segments are listed but can't be picked: they fill from their rules, not by hand.</p>`
		},
		{
			id: 'dashboard',
			title: 'Dashboard',
			routes: ['/'],
			body: `<p>The home page is the pulse of the whole account. <strong>Tiles</strong>: subscribers (with 30-day new / unsubscribed), sends and opens in the last 7 days, conversations awaiting your reply, active automations, the pipeline, and companies going quiet — each opens the matching page.</p>
<p><strong>Last campaign</strong> (top of the side column) shows how your newest broadcast did: sent, opened, clicked, unsubscribed, bounced and replied, each opening that list on the campaign report, plus the change in open and click rate against the campaign before. After a resend to non-openers it splits the original and the resend; every link goes to the original campaign.</p>
<p><strong>Engagement tiers</strong> shows how many contacts are hot / warm / cool / cold with a 90-day trend; <strong>When people engage</strong> is a weekday × hour heatmap in your timezone; <strong>Going cold this month</strong> lists contacts whose tier dropped, with one-click Add to segment or Enroll. An unsubscribed contact is always <em>cold</em>, whatever their score; resubscribing brings the score-based tier back. Tiers are automatic; an automation, the bulk bar, the assistant or you (contact page → Engagement → <strong>Set tier…</strong>) can override one, until cleared or for N days, and the automatic tier keeps computing underneath. <strong>Back to automatic</strong> clears it.</p>
<p><strong>Scanner clicks</strong> don't raise engagement: a burst of 3+ different links within 10 seconds, or the unsubscribe link plus another link, is a security scanner, not a person (window and link count are in Settings → General → Engagement). The contact page shows them greyed as "Link scanned by security software". Unsubscribe-page visits never count either.</p>
<p><strong>Scores</strong> (under Engagement tiers) has one line per active score: contacts per band as a bar, and how many changed band in the last 7 days. Click a score for its Score distribution report.</p>
<p><strong>Activity</strong> is everything that happened, newest first — filter with the chips, pick 25/50/100 rows. For one group of contacts, use the Overview on the Contacts page: the same feed, limited to the filter. The side cards cover accounts to look at, deliverability this week, recent and upcoming campaigns and recent unsubscribes. Red or orange banners at the top flag a stopped heartbeat, overdue enrollments, broken domain authentication or deliverability alerts.</p>`
		},
		{
			id: 'health',
			title: 'Backups & health',
			routes: [],
			body: `<p><strong>Backups:</strong> Contacts → Export CSV for an off-platform copy. The database also keeps 30 days of point-in-time history (D1 Time Travel — see the README for restore commands).</p>
<p><strong>Health:</strong> the dashboard shows a red banner if the automation heartbeat stops ticking, orange if enrollments are stuck overdue. Its <strong>Activity</strong> feed is the quickest pulse check: opens, clicks, replies, unsubscribes (with reason), form signups, new contacts and automation entries/completions, newest first — filter with the chips, and pick 25/50/100 rows. Webhooks → Recent activity shows what every form submission did, including rejected ones.</p>`
		},
		{
			id: 'account',
			title: 'Settings & your account',
			routes: ['/settings'],
			body: `<p>Settings, the tour, and sign-out live under your avatar — click it (top right, or the bottom of the sidebar) for <strong>Settings</strong>, <strong>Take the tour</strong>, <strong>Match device theme</strong>, <strong>Install app</strong> (when your browser offers it), and <strong>Sign out</strong>.</p>
<p>The sun / moon switch in the header flips between light and dark. Until you flip it the app follows your device; <strong>Match device theme</strong> goes back to that.</p>`
		},
		{
			id: 'passwords',
			title: 'Passwords & signing in',
			routes: ['/account', '/settings/users'],
			body: `<p>Sign in with GitHub, or with your <strong>username</strong> (your GitHub login) and a password. Set or change yours under your avatar → <strong>Account</strong>: at least 12 characters, not your username, not a common password. Changing it signs out your other sessions.</p>
<p>Admins can <strong>Generate password</strong> for someone in Settings → Users. It's shown once — share it over a secure channel; they'll be asked to choose their own on first sign-in. <strong>Clear password</strong> makes them GitHub-only again.</p>
<p>5 wrong passwords for a username (or 20 from one network) within 15 minutes locks sign-in for a while.</p>
<p>The <strong>server password</strong> (break-glass) locks for everyone after 5 wrong tries in 15 minutes. Every try and every sign-in with it is listed under <strong>Break-glass sign-ins</strong> in Settings → Users (admins).</p>`
		},
		{
			id: 'invites',
			title: 'Invitations, password reset & email',
			routes: ['/settings/users', '/account'],
			body: `<p>Admins can <strong>Invite by email</strong> in Settings → Users: pick a role and send. The person gets a link (works once, for 7 days) to choose their name and password and is signed in. Pending invites are listed there with <strong>Resend</strong> (a new link; the old one stops working) and <strong>Revoke</strong>.</p>
<p><strong>Forgot password?</strong> on the sign-in page sends a reset link (works once, for 1 hour) — only to a <strong>verified</strong> email. Choosing a new password signs you out everywhere else.</p>
<p>A changed email (by you under Account, or by an admin) stays <strong>unverified</strong> until the confirmation link sent to it is opened. Nobody can sign up on their own: accounts come from an invite or an admin.</p>`
		},
		{
			id: 'setup',
			title: 'Setup checklist',
			routes: ['/settings/setup'],
			body: `<p><strong>Settings → Setup</strong> (admins) checks what this install needs each time you open it. Every row is <strong>Ready</strong>, <strong>Needs attention</strong> (with one line on how to fix it) or <strong>Optional, not set</strong>.</p>
<p><strong>Required:</strong> database migrations up to date, the media bucket bound, <code>SESSION_SECRET</code>, the Postmark server token and both message streams, a Default From address, <code>CRON_KEY</code> and a heartbeat tick in the last 10 minutes. <strong>Postmark:</strong> the webhook points at this install and unsubscribe handling is Custom. <strong>Optional:</strong> one row per integration, with a link to its settings page.</p>
<p>Secrets only ever show as set or not set. While a required check needs attention, admins see a notice on the dashboard (it checks local settings only, not Postmark). After first-run setup you land here.</p>`
		},
		{
			id: 'domain',
			title: 'Custom domain (moving off workers.dev)',
			routes: ['/settings/domain'],
			body: `<p>The app runs at a <code>*.workers.dev</code> URL by default. To serve it from your own hostname (e.g. <code>crm.yourdomain.com</code>), use <strong>Settings → Domain</strong> (admins).</p>
<ol>
<li><strong>Save the hostname.</strong> Unsubscribe links and the List-Unsubscribe header, hosted pages, media URLs, the tracking snippet and the URLs shown in Settings switch to it right away — no redeploy. <strong>Clear</strong> goes back to <code>PUBLIC_BASE_URL</code> in <code>wrangler.jsonc</code>.</li>
<li><strong>Attach it to this Worker.</strong> With the <code>CF_API_TOKEN</code> secret set, <strong>Attach to this Worker</strong> does it through the Cloudflare API. Without it the page lists the dashboard steps (Workers &amp; Pages → this Worker → Settings → Domains &amp; Routes → Add → Custom domain) and the token permissions to create one.</li>
<li><strong>Check status.</strong> Loads <code>https://&lt;hostname&gt;/login</code> from the Worker and shows reachable or not, with the HTTP code.</li>
<li><strong>GitHub sign-in.</strong> A GitHub OAuth App allows one callback URL. Point it at <code>https://&lt;hostname&gt;/auth/github/callback</code>, or create a second OAuth App for the new address.</li>
<li><strong>Redirect other hosts (optional).</strong> Once the status check passes, turn this on to 301 browser visits on the old address to the new one. Webhooks, the API, the heartbeat, one-click unsubscribe, images and tracking keep answering on every address, so nothing already sent or wired up breaks.</li>
</ol>`
		}
		];
	};
	const SECTIONS = $derived(buildSections(platform.mac));

	const currentId = $derived.by(() => {
		const path = page.url.pathname;
		// Longest matching route wins, so /settings/domain opens its own section, not /settings'.
		let best: { id: string; len: number } | null = null;
		for (const s of SECTIONS) {
			for (const r of s.routes) {
				const match = r === '/' ? path === '/' : path.startsWith(r);
				if (match && (!best || r.length > best.len)) best = { id: s.id, len: r.length };
			}
		}
		return best?.id ?? null;
	});

	const visible = $derived(
		filter.trim()
			? SECTIONS.filter((s) => (s.title + ' ' + s.body.replace(/<svg[\s\S]*?<\/svg>/g, '')).toLowerCase().includes(filter.trim().toLowerCase()))
			: SECTIONS
	);

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') open = false;
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
	<div class="hp-backdrop" role="presentation" onclick={() => (open = false)}></div>
	<aside class="hp-panel" aria-label="Help">
		<div class="hp-head">
			<strong>Help</strong>
			<input class="hp-filter" placeholder="Search help…" bind:value={filter} />
			<button
				type="button"
				class="secondary hp-tour-btn"
				onclick={() => {
					open = false;
					startTour();
				}}
			>Take the tour</button>
			<button type="button" class="secondary hp-close" onclick={() => (open = false)}>Close</button>
		</div>
		{#if pwa.canInstall}
			<div class="hp-install">
				<span>Use it like a desktop/phone app.</span>
				<button type="button" class="secondary hp-tour-btn" onclick={promptInstall}>Install app</button>
			</div>
		{:else if pwa.iosHint}
			<p class="hp-install muted">To install: tap Share, then “Add to Home Screen”.</p>
		{/if}
		<div class="hp-body">
			{#each visible as s (s.id)}
				<details open={filter.trim() !== '' || s.id === currentId}>
					<summary>{s.title}</summary>
					<div class="hp-section">{@html s.body}</div>
				</details>
			{/each}
			{#if visible.length === 0}
				<p class="muted hp-none">Nothing matches “{filter}”.</p>
			{/if}
		</div>
	</aside>
{/if}

<button
	type="button"
	class="hp-fab"
	data-tour="help"
	title="Help & docs"
	aria-label="Open help"
	aria-expanded={open}
	onclick={() => (open = !open)}
><Icon name="help" size={20} /></button>

<style>
	/* Help button: the theme's outline control, round. */
	.hp-fab {
		position: fixed; left: var(--space-m); bottom: var(--space-m); z-index: 60;
		width: 40px; height: 40px; border-radius: var(--radius-full);
		display: inline-flex; align-items: center; justify-content: center; padding: 0;
		background: var(--surface); color: var(--neutral-7);
		box-shadow: 0 0 0 var(--border-s) var(--neutral-4), var(--shadow-m);
	}
	.hp-fab:hover {
		background: var(--neutral-3); color: var(--neutral-10);
		box-shadow: 0 0 0 var(--border-s) var(--neutral-5), var(--shadow-m);
	}
	.hp-fab:focus-visible { box-shadow: 0 0 0 var(--border-s) var(--color-1-transparent), var(--focus-halo), var(--shadow-m); }
	.hp-backdrop { position: fixed; inset: 0; z-index: 58; background: transparent; }
	/* Panel: the theme's popover surface (large motion). */
	.hp-panel {
		position: fixed; left: var(--space-m); bottom: 4rem; z-index: 59;
		width: min(440px, calc(100vw - 2rem)); max-width: calc(100vw - 2rem); max-height: min(70vh, 640px);
		display: flex; flex-direction: column;
		background: var(--surface); color: var(--neutral-10); border: 0;
		border-radius: var(--radius-m); box-shadow: var(--border-shadow-s), var(--shadow-l);
		font-size: var(--size-s); line-height: var(--line-s); letter-spacing: var(--tracking-l);
		animation: hp-in var(--motion-large-duration) var(--motion-large-easing);
	}
	@keyframes hp-in {
		from { opacity: 0; transform: scale(var(--motion-popup-scale)); }
	}
	.hp-head {
		display: flex; align-items: center; gap: var(--space-xs);
		padding: var(--space-s) var(--space-m); box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--neutral-4);
	}
	.hp-head strong { font-size: var(--size-m); line-height: var(--line-m); letter-spacing: var(--tracking-m); font-weight: var(--weight-ui-medium); }
	.hp-filter { flex: 1; min-width: 0; }
	@media (max-width: 480px) {
		.hp-head { flex-wrap: wrap; }
		.hp-head strong { margin-right: auto; }
		.hp-filter { flex-basis: 100%; order: 1; }
	}
	.hp-close, .hp-tour-btn { padding: var(--space-xxs) var(--space-s); white-space: nowrap; }
	.hp-install {
		display: flex; align-items: center; justify-content: space-between; gap: var(--space-xs);
		margin: 0; padding: var(--space-xs) var(--space-m); box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--neutral-4);
	}
	.hp-body { overflow-y: auto; padding: var(--space-xs) var(--space-m) var(--space-m); }
	/* Sections: the theme's accordion (trigger s/medium, panel divider, content neutral-8). */
	details { box-shadow: inset 0 calc(-1 * var(--border-s)) 0 var(--neutral-4); }
	details:last-child { box-shadow: none; }
	summary {
		cursor: pointer; padding: var(--space-s) 0; border-radius: var(--radius-s);
		font-weight: var(--weight-ui-medium); color: var(--neutral-10);
		list-style-position: inside;
	}
	summary:hover { color: var(--neutral-10); text-decoration: underline; }
	.hp-section { padding: 0 0 var(--space-m); color: var(--neutral-8); overflow-wrap: anywhere; }
	.hp-section :global(p) { margin: 0 0 var(--space-xs); }
	/* Keyboard shortcuts (#572): fixed 40/30/30 columns so the table never outgrows the panel;
	   words wrap whole (not `anywhere` like the prose), and only a single combo is unbreakable. */
	.hp-section :global(.hp-keys) { width: 100%; table-layout: fixed; border-collapse: collapse; margin: 0 0 var(--space-xs); overflow-wrap: normal; word-break: normal; }
	.hp-section :global(.hp-keys th),
	.hp-section :global(.hp-keys td) { text-align: left; vertical-align: top; padding: var(--space-xxs) var(--space-xs) var(--space-xxs) 0; background: none; }
	.hp-section :global(.hp-keys th:first-child) { width: 40%; }
	.hp-section :global(.hp-keys th:not(:first-child)) { width: 30%; }
	.hp-section :global(.hp-keys :is(th, td):last-child) { padding-right: 0; }
	.hp-section :global(.hp-keys kbd) { font-family: inherit; white-space: nowrap; }
	.hp-section :global(.hp-where),
	.hp-section :global(.hp-note) { color: var(--muted); font-size: 0.9em; }
	.hp-section :global(.hp-note) { display: block; }
	.hp-section :global(blockquote) {
		margin: 0 0 var(--space-xs); padding: var(--space-xs) var(--space-s);
		box-shadow: inset var(--border-l) 0 0 var(--neutral-4); color: var(--muted);
	}
	.hp-section :global(code) {
		font-family: var(--font-mono); font-size: var(--size-xs); background: var(--neutral-3);
		padding: 0 var(--space-xxs); border-radius: var(--radius-xs);
	}
	.hp-section :global(pre) {
		margin: 0 0 var(--space-xs); padding: var(--space-xs) var(--space-s);
		font-family: var(--font-mono); font-size: var(--size-xs); line-height: var(--line-xs);
		background: var(--neutral-3); border-radius: var(--radius-s);
		overflow-x: auto; white-space: pre;
	}
	.hp-none { font-size: var(--size-s); }
	/* Left-sidebar layout (#134): the sidebar owns the bottom-left corner (user chip + its menu),
	   so the help button and its panel move to the bottom-right. */
	:global(html[data-nav='left']) .hp-fab { left: auto; right: var(--space-m); }
	:global(html[data-nav='left']) .hp-panel { left: auto; right: var(--space-m); }
</style>
