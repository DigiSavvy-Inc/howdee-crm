# Connect an AI assistant

A running instance can be used by an outside AI assistant (Claude Code, Claude Desktop, Cursor or
any other MCP client) and by your own scripts. There are two doors, and both use the same keys:

- **The MCP server** at `https://<your-app>/mcp`: ready-made tools an assistant can call.
- **The Data API** at `https://<your-app>/api/v1/*`: plain JSON over HTTPS.

No MCP tool and no draft endpoint can send an email, schedule a send, activate an automation or
enroll a contact. Assistants create and edit **drafts**; a person reviews them in the app and sends
or activates them. (A `read_write` key can start contacts on live automations through the Data API;
see below.)

This is separate from the assistant built into the app (the chat panel, configured in
**Settings → Assistant**), which uses your Anthropic key and the signed-in user's session.

## 1. Create a key

An admin creates keys in **Settings → API**. Each key has one scope:

| Scope (in the app) | Value | What it can do |
| --- | --- | --- |
| Read-only | `read` | Read data: every `GET` on the Data API, every read tool on MCP |
| Drafts only | `campaigns:draft` | Create and edit campaign drafts, nothing else (no reads) |
| Automation drafts only | `automations:draft` | Create and edit draft automations, nothing else (no reads, never activate) |
| Read + write | `read_write` | Everything the API offers, including deletes, bulk contact changes and enrolling contacts in an active automation |

The full key is shown **once**, when it is created or rotated. The app stores only a hash, so copy
it straight into your client's secret store. Rotate or revoke a key from the same page at any
time; revoking takes effect on the next request.

**Pick the narrowest scope that does the job.** For an assistant that answers questions, use
`read`. For one that drafts emails or automations for you to review, use a draft scope (and a
separate `read` key if it also needs to look things up). Reserve `read_write` for scripts you
wrote and trust: it can change and delete records.

Send the key as a header on every request:

```
Authorization: Bearer <key>
```

Keys are never accepted in the URL.

## 2. Connect over MCP

**Settings → API** shows your instance's MCP address and copy-paste snippets. The shapes are:

Claude Code:

```sh
claude mcp add --transport http dscrm https://<your-app>/mcp --header "Authorization: Bearer <key>"
```

Clients that read a JSON config (`.mcp.json`, Cursor and similar):

```json
{
  "mcpServers": {
    "dscrm": {
      "type": "http",
      "url": "https://<your-app>/mcp",
      "headers": { "Authorization": "Bearer <key>" }
    }
  }
}
```

Claude Desktop, through the `mcp-remote` bridge:

```json
{
  "mcpServers": {
    "dscrm": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-app>/mcp", "--header", "Authorization: Bearer <key>"]
    }
  }
}
```

The server speaks MCP over Streamable HTTP, answering with plain JSON (no streaming, no session).
It accepts protocol versions `2025-06-18`, `2025-03-26` and `2024-11-05`. Each key is limited to
about 60 tool calls per minute.

### Tools per scope

The client only sees the tools its key may use.

| Scope | Tools |
| --- | --- |
| `read` | `search_contacts`, `get_contact`, `list_groups`, `list_campaigns`, `get_campaign`, `run_campaign_checks`, `list_automations`, `get_automation`, `get_automation_spec_format`, `get_deliverability`, `list_scores`, `get_contact_scores`, `get_score_leaders`, `get_engagement_summary`, `list_forms`, `get_form_submissions` |
| `campaigns:draft` | `create_campaign_draft`, `update_campaign_draft` |
| `automations:draft` | `build_automation`, `update_automation`, `replace_automation_spec`, `add_automation_step`, `edit_automation_step`, `delete_automation_step`, `reorder_automation_steps`, `duplicate_automation`, plus `get_automation_spec_format` (a format reference, no CRM data) |
| `read_write` | All of the above |

There is no send, schedule, activate or enroll tool at any scope. Draft tools return a link to the
draft in the app (`compose_url` for campaigns, `editor_url` for automations); share it with the
person who will review it.

A typical drafting session: the assistant calls `get_automation_spec_format`, builds a flow with
`build_automation`, and hands you the editor link. You open it, check the canvas and click
**Activate** yourself.

## 3. Use the Data API directly

`GET https://<your-app>/api/v1` checks a `read` or `read_write` key and lists what it can reach (the
discovery document, which also carries the automation spec vocabulary); a draft-only key gets a
403 there. Other responses are `{ "data": … }`, lists add
`{ "pagination": { "limit", "offset", "total", "has_more" } }`, errors are `{ "error": "…" }`.
Paging: `limit` (default 50, max 200) and `offset`.

| Area | Endpoints | Scope needed |
| --- | --- | --- |
| Contacts | `GET /contacts`, `GET /contacts/:id` and its `/engagement`, `/automations`, `/conversations`, `/pipeline`, `/scores`, `/site-activity` | `read` |
| Contacts (write) | `POST /contacts`, `PATCH` / `DELETE /contacts/:id`, `POST /contacts/bulk`, `POST` / `DELETE /contacts/:id/pipeline`, `POST /contacts/:id/scores/:scoreId/adjust` | `read_write` |
| Companies | `GET /companies`, `GET /companies/:id`, `GET /companies/:id/metrics` | `read` |
| Companies (write) | `POST /companies`, `PATCH /companies/:id` | `read_write` |
| Lists, events, engagement, scores, site events, newsletter, pipeline, forms | `GET /lists`, `/events`, `/engagement/summary`, `/scores`, `/site-events`, `/newsletter`, `/pipeline/stages`, `/pipeline/cards`, `/forms`, `/forms/:id/submissions` | `read` |
| Campaigns | `GET /campaigns`, `GET /campaigns/:id`, `POST /campaigns/:id/checks` | `read` |
| Campaign drafts | `POST /campaigns`, `PATCH /campaigns/:id` (drafts only) | `campaigns:draft` or `read_write` |
| Campaign delete | `DELETE /campaigns/:id` (an unsent, empty draft) | `read_write` |
| Automations | `GET /automations`, `GET /automations/:id` | `read` |
| Automation drafts | `POST /automations`, `PATCH /automations/:id`, `PUT /automations/:id/spec`, `POST /automations/:id/steps`, `PATCH` / `DELETE /automations/:id/steps/:stepId`, `POST /automations/:id/steps/reorder`, `POST /automations/:id/duplicate` | `automations:draft` or `read_write` |
| Automation delete, enroll | `DELETE /automations/:id` (an unused draft), `POST /automations/:id/enroll` | `read_write` |
| Reports | `GET /reports`, `GET /reports/:ref/run`, `POST /reports/run` | `read` |

All paths are under `/api/v1`. Some notes:

- Campaign draft endpoints never send or schedule. `scheduled_at` on a draft records the intended
  time only; a person schedules it in the app.
- Automation write endpoints refuse a `status`, `activate` or `enroll` field, and only touch
  automations in draft (or paused, when nobody is mid-flow).
- Keys carry no user role, so reports run as a non-admin member: admin-only figures are refused.
- `POST /automations/:id/enroll` starts contacts on a live automation, and contact writes can too:
  adding a tag fires "added to tag" triggers, and `enroll: true` with a `list` enrolls the contact
  in that list's automations. Don't give an assistant a `read_write` key unless you want it to be
  able to do that.

## 4. The command-line client

`scripts/dscrm.mjs` (Node 18 or newer, no dependencies) wraps the most common calls for shell use:

```sh
export DSCRM_URL=https://<your-app>
export DSCRM_KEY=<key>
node scripts/dscrm.mjs contacts search "jane"
node scripts/dscrm.mjs automations list
node scripts/dscrm.mjs campaigns draft newsletter.md --subject "October update"
```

Run it without arguments for the full command list.

## Keeping it safe

- Treat a key like a password: store it in your client's secret store or environment, never in a
  repository, a shared document or a chat.
- One key per assistant or script, labelled so you can tell them apart in **Settings → API**,
  which shows when each was last used and how many requests it made.
- Anything an assistant reads from the CRM (names, notes, email replies) is data written by other
  people. Don't let an assistant act on instructions it finds there.
- Revoke keys you no longer use.
