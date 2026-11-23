-- #346: starter on-demand assistant skill for building automations from a description
-- (build_automation and the step tools). An ordinary ai_skills row (#302): editable,
-- disableable and deletable in Settings → Assistant → Skills. INSERT OR IGNORE, so an
-- operator's own skill with this name is kept as is.
INSERT OR IGNORE INTO ai_skills (name, description, body, mode, enabled, sort) VALUES (
  'automation-building',
  'How to turn a description into a draft automation: the questions to ask, sensible defaults, and proposing the outline before calling build_automation.',
  'Use this when the user describes an automation (a drip flow) they want built or changed.

## Ask first, briefly
Before building, make sure you know these. Ask only for what the user did not say, in one short message:
- **Trigger**: who enters and when — added to a list, segment or tag; enters a pipeline stage; visits a page; a company metric crosses a threshold; or manual enrollment.
- **Goal**: what the flow is for (book a call, onboard, re-engage) — it decides the emails and the exit.
- **Timing**: the waits between steps, and whether sends should land on weekdays only.
- **Exit conditions**: what takes someone out early (they replied, booked, got a tag, moved stage). Model them as a branch whose YES lane ends, or an End step.

## Sensible defaults (say which ones you used)
- Put a wait of at least 1–2 days **before** an opened / clicked branch: the branch checks engagement recorded by the time the contact reaches it.
- `weekday_only: true` on email waits for B2B audiences.
- Re-entry `once` unless the user wants people to go through again.
- From = the default From (omit `from_email`) unless the user names an approved sender.
- Email bodies: short, one call to action, merge tags like `{{first_name}}` (load the `email-copywriting` skill for the copy). No signature or unsubscribe footer — the app adds them.
- Name lists, tags, segments, pipeline stages, sites and other automations by name; the tool resolves them. A missing tag is created on Approve.

## Always propose the outline before building
1. Write the flow as a short indented outline: the trigger, then each step with its wait (Email “subject”, Add tag, If opened … → YES / NO lanes, End).
2. Ask "Build it as a draft?" and wait for a yes.
3. Then call `build_automation` with the whole spec. If it returns problems, fix them and call it again — nothing is saved until the spec is valid.
4. The user approves the card; the automation is created as a **draft**. Say they review and activate it in Automations — you never activate it, enroll anyone or send.

## Changing an existing flow
- Read it with `get_automation_spec` first (it lists every step id and lane).
- Edit with `edit_automation_step`, `add_automation_step` (use `parent_step_id` + `branch_label` for a branch lane), `reorder_automation_steps`, `delete_automation_step`. Only draft or paused automations can be changed.
- To copy a flow, read its spec and pass it, renamed, to `build_automation`.',
  'on_demand', 1, 7
);
