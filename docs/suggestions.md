# Suggestions

> **Partly built.** This page is the spec for epic #711, built in #712 to #716. The rules, the
> storage and the heartbeat pass are built (#712), and so are the panel (#714), Settings →
> Suggestions and the per-user Account switch (#715); the AI wording (#713) and the API /
> assistant / digest (#716) are not yet. Until the AI wording ships, Settings → Suggestions always
> shows "Rules only". If the build differs, the PR that changes it updates
> this page too.

Suggestions tell the team who to contact and what to send next. A small panel slides in at the
bottom right of the app with one card per suggestion: follow up with a person, send a campaign to a
group, or try a different kind of marketing. You page through the cards, open one to see why it was
made, and take the next step.

Rules in the app find the candidates. An AI model, if you have one set up, ranks them and writes the
reasons in plain words. With no AI key the rules still work and use fixed wording.

**Nothing is ever sent, scheduled, activated, enrolled or saved from a suggestion.** Each next step
opens the right page with the details filled in. A person reads it, changes it if needed, and
presses Send or Save themselves.

Suggestions are off until an admin turns them on in **Settings → Suggestions**.

## The three kinds

| Kind | Chip | What it means |
| --- | --- | --- |
| `follow_up` | Follow up | A person on the team should contact someone: reply, check in, or move a deal along. |
| `campaign` | Campaign | A group (a list, tag or segment) hasn't heard from you in a while. Send it something. |
| `marketing` | Try something else | What you are doing with a group isn't working. Re-engage them, move them to an automation, or try a personal touch. |

An admin can turn each kind on or off.

## The rules

Each rule has an on or off switch and its own thresholds in Settings → Suggestions. The defaults
are below. All of them are on by default once the feature is on.

A few words used below:

- **Personal email** means a one-to-one email: a reply from Conversations, an email from the
  contact page, or a sent message synced from Gmail. Campaigns and automation emails don't count.
- **Active members** follow the active audience rule: subscribed or waiting to confirm, and not
  archived.
- **Score** means the score picked in Settings → Suggestions. It starts as the built-in Lead score.

| Rule | Kind | Finds | Default thresholds | Allowed range |
| --- | --- | --- | --- | --- |
| Awaiting our reply (`awaiting_reply`) | Follow up | A conversation where the last message is from them and it has waited longer than the limit | 48 hours | 1 to 720 hours |
| Gone quiet after replying (`quiet_after_reply`) | Follow up | Someone who has replied to us before, where our last personal email to them was sent at least N days ago and they haven't answered | 14 days | 3 to 180 days |
| Warming up (`hot_engagement`) | Follow up | Someone showing interest who hasn't had a personal email lately. Any one of: score up by 10 or more in 7 days, 2 or more campaign clicks in 14 days, or site visits on 2 or more different days in 7 days. And no personal email to them in 30 days | Score +10 in 7 days; 2 clicks in 14 days; visits on 2 days in 7; no personal email in 30 days | Points 1 to 1,000; clicks 1 to 50; visit days 2 to 14; days 1 to 365 |
| Form with no follow-up (`form_no_followup`) | Follow up | A form submission from the last 14 days with no personal email to that contact within N days of it | 3 days | 1 to 30 days |
| Stalled deal (`stalled_deal`) | Follow up | An open deal (not Won or Lost) that has sat in the same stage longer than the limit. Assigned to the deal owner | 21 days | 3 to 365 days |
| Group not mailed (`group_unmailed`) | Campaign | A list, tag or segment with at least N active members that hasn't been sent a campaign in N days | 25 members; 30 days | 1 to 100,000 members; 7 to 365 days |
| Cold group (`cold_members`) | Try something else | A list, tag or segment where more than half of its active members opened none of the last N campaigns sent to it | 5 campaigns | 2 to 20 campaigns |

Notes on the rules:

- **Who never appears.** Unsubscribed and archived contacts never appear in a suggestion, as a
  subject or as evidence, and they don't count toward a group's size. This is the same active
  audience rule the lists and counts use.
- **Groups.** Companies are not groups for these rules. Archived lists and segments are skipped,
  and so are the bookkeeping tags the app writes itself (`hygiene:…`, `snapshot:…`, `excluded: …`,
  `source:` / `role:` / `platform:` / `situation:` / `icp:` tags, `unverified-domain`) and groups
  named `zz-…` or "archived". `group_unmailed` also skips a group with a campaign to it scheduled
  or sending. `cold_members` only looks at groups with at least N campaigns sent to them (N = its
  setting, 5 by default) and at least as many active members as `group_unmailed` asks for. "More
  than half" counts the active members that were sent at least one of those campaigns. Apple Mail's
  automatic opens count as opens there, so the rule errs on the side of not flagging a group.
- **Clicks** for Warming up are clicks on any campaign or automation email.
- **Form submissions** are submissions of the app's own forms and of website forms sent to a
  webhook key, when the submission added or updated a contact. Spam and rejected submissions are
  ignored. Any personal email to the contact after the submission ends the suggestion, even one
  sent after the N days.
- **One per thing.** There is at most one open suggestion per subject and rule. A contact who
  matches two rules can have two cards, one per rule.
- **When the condition goes away**, the suggestion closes by itself. If you reply to the
  conversation, the Awaiting our reply card is gone on the next pass. A suggestion closed this way
  has no cooldown: if the condition comes back, so does the card.
- **A rule or kind that is off** makes nothing new and closes nothing; its open suggestions are
  hidden until it is back on.
- **Wording without AI** uses dates ("wrote on Nov 20"), not "3 days ago", so it never goes stale.

### Cooldowns

- **Done** and **Dismiss** (by a person, or through the API) keep that rule quiet for that subject for 30 days, unless the evidence
  changes (a new reply, a new form submission, the deal moves stage). The 30 days are a setting
  (1 to 365).
- **Snooze** hides a suggestion until the time you picked, then it comes back on the next pass if
  the condition still holds.
- Evidence "changes" when something new happens, not when time passes. A conversation that has
  simply waited longer is not new evidence.

## The panel

### Collapsed: the pill

When there are suggestions for you, a small pill sits at the bottom right, just above the assistant
button, with the count: "4 suggestions". If you don't have the assistant, the pill takes the
corner itself. It moves up out of the way of bottom bars (the bulk bar, save bars, the update
notice) and never covers the assistant button.

The count is the open suggestions in your panel: the ones assigned to you and the ones that belong
to the whole team. Suggestions assigned to someone else are not in your panel.

The panel is hidden on public pages (forms, hosted pages, the unsubscribe page), on sign-in and
setup, and while the compose screen is open.

### The card

Click the pill and it opens into one card:

- the kind chip (Follow up, Campaign, Try something else)
- who or what it is about, as a link (a contact, a company, a deal or a group)
- the reason in one line
- the main next step as a button
- "2 of 7" with Previous and Next

Page through with the Previous and Next buttons, the left and right arrow keys, or by swiping on a
phone. With AI on, the cards are in the order the model ranked them. Without AI, follow-ups come
first, then campaigns, then the rest, and the oldest wait comes first within each rule.

The pill opens into the card by itself at most once per browser session, and only when there is
something new since you last looked. Minimise it and it stays a pill. The app remembers that in
this browser, for you.

### The detail view

**More** on a card opens a larger panel with:

- the full reason (one or two sentences)
- the **evidence** as links: the contact, company, deal, conversation, campaign, form submission
  or group the suggestion is built on, each with its date
- the next step, and other next steps when the rule has more than one
- a **draft opening line** when the model wrote one, which you can copy or take into the composer
- **Done**, **Snooze** (1 day, 1 week, 1 month) and **Dismiss**, with an optional reason

On a phone the detail view is a bottom sheet.

Done, Snooze and Dismiss apply to everyone, because suggestions are shared. Once one person marks
a follow-up Done, it leaves everyone's panel.

### What the next steps do

A next step only opens a page. It fills things in for you and stops there.

| Next step | Opens | URL |
| --- | --- | --- |
| Reply | The conversation, with the reply box focused and the draft opening line in it, if there is one | `/conversations/<key>?reply=1[&opening=…]` |
| Email them | Compose in 1:1 (Direct) mode, addressed to the contact, with the draft opening line as the first paragraph | `/compose?direct=1&contact=<id>[&opening=…]` |
| Open contact / Open company / Open deal | That record (a deal opens its contact's Pipeline card) | `/contacts/<id>`, `/companies/<id>`, `/contacts/<id>#pipeline` |
| Send a campaign | Compose, with the group already picked as the audience | `/compose?include_id=<group>` |
| Re-engage | Compose, with the group picked and the subject idea "Still want to hear from us?" in the subject field | `/compose?include_id=<group>&reengage=1` |
| Move to an automation | The automation picker: a card on Automations listing the active automations. Picking one opens its **Enroll contacts** dialog with the group chosen and its active members counted. You confirm with Enroll | `/automations?enroll_list=<group>` → `/automations/<id>?enroll_list=<group>` |
| See who's cold | The group's member list | `/lists/<group>` |

The panel adds `opening=` (the draft opening line, at most 1,000 characters) only to Reply and
Email them, and only when the suggestion has one. Compose sends to lists and segments: for a
**tag**, Send a campaign and Re-engage open Compose with a note that it is a tag and nothing picked.
A prefill never applies on top of a saved draft (`/compose?draft=<id>`).

You review what was filled in and decide. No email goes out, no automation starts and no record
changes until you press the button on that page.

### Keyboard and accessibility

- Everything is a real button with a label.
- Escape closes the detail view, then the card.
- Focus stays inside the detail view while it is open and goes back to the pill when it closes.
- The count is announced politely when it changes, without stealing focus.
- With reduced motion turned on in your system, the panel appears without sliding.
- Previous and Next wrap around; the left and right arrow keys page while the card has focus.

### Where it lives (for developers)

- `src/lib/components/SuggestionsPanel.svelte`, mounted once in the root layout. The layout load
  returns only `suggestions: { count, latest }` (`panelSummary` in
  `src/lib/server/suggestions/panel.ts`; null when the feature is off or not open to this user),
  so no cards are read until the pill is opened.
- `GET /api/suggestions` (session) returns the cards: team rows plus the ones assigned to you,
  each with `subject_url`. Feature off or not open to you: 403.
- `POST /api/suggestions/<id>` (session) takes `{ "op": "done" }`, `{ "op": "snooze", "days": 1 | 7 | 30 }`
  or `{ "op": "dismiss", "reason": "…" }` (reason optional, up to 200 characters). Done and Dismiss
  set `closed_by = 'user'` and `closed_by_user_id`, which starts the cooldown. Already closed: 409.
  A suggestion assigned to someone else: 404. This is the only write; nothing in this path sends,
  schedules, activates or enrolls.
- In this browser the panel remembers, per user, the newest suggestion you have seen and whether
  you minimised it (localStorage `ds-suggestions:<user id>`); the once-per-session pop-up uses
  sessionStorage `ds-suggestions-autoopened`.
- The pill and card stay clear of the assistant button (`aboveFab`), `--sticky-actions-bottom`,
  the bulk bars, the update notice and the safe areas, and hide in the editor's Write mode.

### Turning it off for yourself

**Account → Show the suggestions panel** turns the panel on or off for you only. It is on by
default. Turning it off hides the pill and the card for you; the suggestions still exist for the
rest of the team, and the assistant can still read them for you. (Stored as
`users.suggestions_panel`, migration `0135`; the panel and its count get no viewer for you, while
the assistant tool asks for one with `{ panel: false }`.)

## For admins and self-hosters

### Turning it on

**Settings → Suggestions** (admins only):

| Setting | Default | What it does |
| --- | --- | --- |
| Suggestions | Off | The whole feature. Off hides the panel for everyone at once and stops the heartbeat work. |
| Kinds | All three on | Follow up, Campaign, Try something else. A kind that is off makes no new suggestions, and its open ones are hidden. |
| Rules | All on | Each rule's switch and thresholds, with the defaults and ranges in the table above. |
| Score for Warming up | Lead score | Which active score the `hot_engagement` rule watches. |
| Cooldown | 30 days | How long Done and Dismiss keep a rule quiet for a subject. |
| Who sees suggestions | Admins only | Admins only, or everyone. |
| Most new suggestions per day | 25 | 1 to 200. New suggestions stop for the day once it is reached; open ones stay. The day resets at midnight UTC. |
| Use AI to rank and word suggestions | On | Off means rules only, even when a key is set. |

A threshold change takes effect on the next heartbeat tick. Saving the page tells the next tick to
run the rules again, so you don't wait for the hourly pass.

Every save is checked: a number outside its range (or blank, or not a whole number) is refused
with the allowed range next to the field, and nothing is saved. The score must be an active one.

### Who sees what

- **Who sees suggestions** decides who gets the panel. With "Admins only", members see no panel and
  the assistant and API still follow the same rule for them.
- Suggestions are shared across the team. A stalled deal suggestion is assigned to the deal's
  owner and shows only in their panel. A deal with no owner, and every other suggestion, belongs to
  the team.
- A person only sees a suggestion about something they can already see in the app.
- **Billing data** (Zoho Books) is only ever evidence, shown only to people who may see billing
  (`canSeeBilling`). It is never in a suggestion's title, reason or draft, and it is never sent to
  the model, because one suggestion's wording is shared by everyone who sees it.

### Picking the model

The model is picked in **Settings → Assistant → Model per feature → Suggestions**. Settings →
Suggestions links there and shows the model in use, or "Rules only" when AI is off.

- Ranking and wording uses no tools, so any allowed model can be picked, including
  OpenAI-compatible models without tool use (see [ai-providers.md](ai-providers.md)).
- With no pick, it uses the default model from Settings → Assistant. A small, cheap model is usually
  enough for this job. Ranking a short list and writing two sentences per card doesn't need the
  largest model.
- An unpriced OpenAI-compatible model is recorded at $0 and doesn't count toward the spend caps.
  Set its prices if you rely on the caps.

### Rules only, with no key

AI wording needs all of these:

- Suggestions on, and **Use AI to rank and word suggestions** on
- Settings → Assistant **Access** is not Off
- a key for the provider of the picked model
- the app's monthly spend cap not reached

If any of them is missing, suggestions still appear, built by the rules, in fixed wording such as
"Ana Example replied 3 days ago and is waiting on us." Nothing breaks and nothing errors. When AI
comes back, the next pass rewrites the open cards.

### Cost and spend caps

- The model is only called from the heartbeat. Opening a page never calls it.
- Each call sends up to 20 open suggestions at once. If nothing in those 20 has changed since the
  last call (same `input_hash`), there is no call.
- At most one call per hour. An error waits an hour before the next try.
- Each call's cost is split across the suggestions it wrote and stored on them (`cost_micros`).
  It counts toward the app's **monthly cap** in Settings → Assistant. Heartbeat work has no user,
  so the per-person daily cap doesn't apply. Once the monthly cap is reached, AI wording stops
  until the next UTC month and the rules carry on.
- A rough guide: one call is a few thousand tokens in and about two thousand out. On Claude Sonnet
  that is a few cents a call; on Claude Haiku it is a fraction of a cent. Spend by model shows in
  Settings → Assistant → Usage.

### The heartbeat schedule

Suggestions are built by the heartbeat Worker, the same one that runs automations. No new cron and
no new Worker.

- **Rules pass:** at most once an hour (sooner after a settings save). It runs the rules, adds new
  suggestions, refreshes open ones whose evidence changed, closes ones whose condition is gone and
  reopens snoozed ones that are due. Each tick handles at most 200 suggestions and picks up where it
  stopped on the next tick.
- **AI pass:** after a rules pass, when AI is on (see above).
- **Pruning:** closed suggestions are deleted after 180 days, but never before the start of the
  current month, so the month's spend stays countable.
- With Suggestions off, the tick does no suggestions work at all.

The tick response reports the work as `suggestions` (created, updated, closed, reopened, AI calls,
or the reason it skipped).

### API

The Data API (Settings → API) has two endpoints. They use the same visibility rules as the panel,
and an API key reads as a member would: no billing evidence. With Suggestions off they answer 403.

`GET /api/v1/suggestions` (read scope) lists suggestions, newest first, with the usual `limit` and
`offset` paging. Filters:

- `kind`: `follow_up`, `campaign` or `marketing`
- `status`: `open` (default), `done`, `dismissed`, `snoozed` or `all`
- `assigned_user_id`: a user id, or `none` for team suggestions

Each item:

```json
{
  "id": 41,
  "kind": "follow_up",
  "rule": "awaiting_reply",
  "subject": { "type": "contact", "id": 812, "label": "Ana Example", "url": "https://crm.example.com/contacts/812" },
  "title": "Reply to Ana Example",
  "why": "Ana asked about pricing 3 days ago and is still waiting on us.",
  "evidence": [{ "id": "e1", "type": "conversation", "label": "Re: Pricing question", "url": "https://crm.example.com/conversations/812", "at": "2026-11-20T15:04:00Z" }],
  "action": { "type": "reply", "url": "https://crm.example.com/conversations/812?reply=1" },
  "draft_opening": "Thanks for your patience, Ana. Here are the plans we talked about.",
  "assigned_user_id": null,
  "status": "open",
  "snooze_until": null,
  "model": "claude-haiku-5-5",
  "created_at": "2026-11-20T16:00:00Z",
  "updated_at": "2026-11-22T09:00:00Z"
}
```

`POST /api/v1/suggestions/<id>` (read_write scope) changes the status:

- `{ "status": "done" }`
- `{ "status": "snoozed", "snooze_until": "2026-12-01T09:00:00Z" }` (at most 90 days ahead)
- `{ "status": "dismissed", "reason": "Already called them" }` (reason optional, up to 200
  characters)

It can't change anything else, and nothing it does sends mail.

### The assistant tool

The assistant has one read-only tool, `list_suggestions` (shown as "Read the suggestions"). It
takes `kind`, `status` and `mine` (only ones assigned to me) and returns up to 25 suggestions with
their reasons and evidence links. It follows the same visibility rules as the panel for the person
asking. There is no tool that marks a suggestion done, snoozes or dismisses it.

Ask it things like "who should I follow up with today?" or "which lists haven't had a campaign in a
while?".

### The weekly digest

The **Weekly digest** scheduled job (Settings → Assistant → Scheduled jobs) gets a short
**Suggested follow-ups** section at the end of its email: the top 5 open suggestions, each with its
title, its one-line reason and a link that opens it in the app.

- The app adds this section, not the model, from suggestions already stored. It costs nothing extra.
- It is a checkbox on the job, **Add suggested follow-ups**, ticked for the Weekly digest preset and
  off for other jobs.
- It is left out when Suggestions are off or nothing is open. It never includes billing evidence.

### Privacy and safety

- **No tools.** The ranking and wording call passes the model no tools. It can only return text.
- **Data, not instructions.** The evidence goes to the model as JSON inside `<data>` tags, with the
  rule that it is data, not instructions. Reply excerpts and names are written by other people, so
  text in them that looks like an instruction is ignored.
- **Checked output.** Each reason must cite evidence ids that exist. A reason that cites anything
  missing is thrown away and the card keeps its rule wording. The next step is always one of the
  steps the rule offers; the model can't invent a link.
- **What the model sees:** names, company names, dates, counts, deal stages and short excerpts of
  inbound replies (up to 500 characters each, cleaned). Not email addresses, not billing data, not
  keys.
- **Never logged:** the prompt, the evidence sent and the key.
- **Never sends.** No suggestions code can send, schedule, activate or enroll anything.
- **Unsubscribed and archived contacts never appear**, in the panel, the API, the assistant tool or
  the digest.

### Environment variables

None. Suggestions use the heartbeat and AI settings you already have: `CRON_KEY` for the tick, and
the AI key from Settings → Assistant (or `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`).

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| No pill at all | Suggestions are off, you're a member and Who sees suggestions is "Admins only", you turned the panel off in Account, or there is nothing open for you. |
| Cards use plain wording | AI is off. Settings → Suggestions shows "Rules only"; the list in [Rules only, with no key](#rules-only-with-no-key) says why. |
| A suggestion keeps coming back | Its evidence keeps changing (new replies, new visits). Turn the rule off or raise its threshold. |
| A dismissed suggestion came back early | Something new happened, such as a new reply. That ends the cooldown on purpose. |
| Nothing new for hours | The day's limit (Most new suggestions per day) was reached, or the heartbeat stopped: the dashboard shows a red banner then. |
| A member can't see a stalled deal card | It is assigned to the deal owner and shows only in their panel. |
