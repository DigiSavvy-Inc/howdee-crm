-- #309: starter on-demand assistant skill for the drafting tools (campaign drafts, automation
-- email steps). An ordinary ai_skills row (#302): editable, disableable and deletable in
-- Settings → Assistant → Skills. INSERT OR IGNORE, so an operator's own skill with this name
-- is kept as is.
INSERT OR IGNORE INTO ai_skills (name, description, body, mode, enabled, sort) VALUES (
  'email-copywriting',
  'Voice, structure, call to action, length and preheader guidance for writing or editing an email draft (campaign or automation step).',
  'Use this when you write or rewrite an email: a new campaign draft, an automation email step, or a change like "make it shorter" or "add a P.S.".

## Voice
- Write like one person emailing another: plain words, "you" and "I", contractions. No hype, no exclamation-mark stacks, no ALL CAPS.
- Match the sender. Read a recent sent campaign (`list_campaigns`, `get_campaign`) when you don''t know the voice yet, and keep its tone.
- Personalise with merge tags only where they read naturally: `{{first_name}}` in the greeting (it falls back to "there"). Never invent a merge tag; custom fields are `{{field:<name>}}`.

## Structure
1. **Opening line** — why this email, why now, in one or two sentences. No "I hope this finds you well".
2. **Body** — one idea per email. Short paragraphs (1–3 sentences); a short list when there are 3+ parallel points.
3. **One call to action** — a single clear next step, as a button or a plain link with a verb ("Book a 20-minute call", "Read the case study"). A second link only if it is the same action.
4. **Sign-off** — short. The app adds the signature and the unsubscribe footer: don''t write them.
5. **P.S.** (optional) — one line that repeats the call to action or adds one human detail.

## Length
- Campaigns: 75–200 words is the default; announcements can be shorter, a story-led newsletter longer.
- Automation steps: shorter than campaigns, 50–150 words, each step doing one job (welcome, value, ask).
- "Make it shorter" means cut by about a third: drop the weakest paragraph and the throat-clearing, keep the call to action.

## Subject and preheader
- Subject: 30–50 characters, specific, sentence case; fits a phone inbox (~40). Check options with `suggest_subject_lines` before offering them, and let the user pick — never apply one they didn''t choose.
- Preheader: 40–90 characters that continue the subject (not repeat it) and give a reason to open. Always set one on a new draft.

## Working on a draft
- On a draft, call `get_draft_sections` first. Change one part with `rewrite_draft_section` (the intro, a paragraph, the P.S.); replace the whole body only when asked (it needs the user''s approval).
- After a change, say in one line what changed and link the draft (Open in composer). The user sends or schedules it — you never do.',
  'on_demand', 1, 5
);
