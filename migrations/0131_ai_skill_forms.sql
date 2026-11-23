-- #517 (Forms 5/7): starter on-demand assistant skill "Forms" — house rules for drafting forms
-- with create_form_draft / update_form. An ordinary ai_skills row (#302): editable,
-- disableable and deletable in Settings → Assistant → Skills. INSERT OR IGNORE, so an
-- operator's own skill with this name is kept as is.
INSERT OR IGNORE INTO ai_skills (name, description, body, mode, enabled, sort) VALUES (
  'forms',
  'House rules for drafting and changing forms (sign-ups, surveys, RSVPs): consent, mapping, length, pages, logic, and proposing the questions before create_form_draft.',
  'Use this when the user wants a form drafted or changed: a sign-up, a survey, an RSVP, a booking request.

## House rules
- **Marketing sign-ups always get consent.** Any form that adds people to a newsletter or marketing list includes a required `consent` question ("Yes, email me … I can unsubscribe at any time."). Suggest `double_optin: true` for public sign-ups.
- **Map the email to the contact.** Every form has a required Email question mapped `{ to: "contact", field: "email" }`, unless the user asks for anonymous submissions (`settings.allow_anonymous`).
- **Map what the CRM should keep:** names and company to contact fields, other answers to custom fields (`meta`) or tags; leave an answer unmapped only when it belongs to the submission alone.
- **Keep it short:** under 8 questions unless the user asks for more. Cut nice-to-haves first.
- **Prefer a page break after 5 questions**, with a short page title. Give each `page_break` an `id` so page jumps can name it.
- **Logic only where it helps:** show a follow-up question only to the people it applies to (`show_when` on an earlier answer); use a page jump to skip a page that doesn''t apply; use outcomes to tag, add to a list, notify someone or swap the thank-you message.
- Name lists, topics and automations by name; the tool resolves them. `notify` takes `["me"]`.

## Always propose the questions first
1. List the questions in order: the question, its type, required or not, where the answer goes, and any logic in words ("Show *Platform* when *Role* is not Developer").
2. Ask "Draft it?" and wait for a yes.
3. Call `create_form_draft` with the whole spec. If it returns problems (`path: message`), fix the spec and call it again — nothing is saved until it is valid.
4. The user approves the card; the form is created as a **draft**. Give the builder link (Open in builder) and say they review and publish it themselves — you never publish, unpublish, archive or delete a form, and you never set its allowed origins or webhook.

## Changing a form
- Read it with `get_form` first (it lists the questions in words and returns the spec with field ids), edit the spec and pass it whole to `update_form`. Keep the field ids and answer keys of questions that stay, so existing submissions still line up.
- Only drafts can be changed. A published form is refused: tell the user to unpublish it or duplicate it in the builder first.
- To read results, use `get_form_submissions` (`summarize: true` counts answers by option).',
  'on_demand', 1, 8
);
