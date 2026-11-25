# AI providers

The AI features (the assistant chat, scheduled jobs, Ask AI in the editor, Draft reply, account
briefs, the report builder's "Describe it" box and resend subject suggestions) reach a model through
one interface, so an install can use more than one provider. Claude (Anthropic) is the default and
the only provider an install needs.

## Using an OpenAI-compatible provider

Prompts and the CRM data an AI feature works with are sent to the base URL you set, so only point it
at a service you trust.

Settings → Assistant → **Other providers: OpenAI-compatible** takes any endpoint that speaks the
OpenAI Chat Completions API with streaming (`POST <base URL>/chat/completions`, `stream: true`):

| Provider | Base URL |
| --- | --- |
| OpenAI | blank (`https://api.openai.com/v1`) |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` |
| Cloudflare Workers AI | `https://api.cloudflare.com/client/v4/accounts/<account id>/ai/v1` |
| A server you run | its OpenAI-compatible URL, reachable from the Worker |

1. Enter the base URL and, optionally, a name ("OpenRouter"). It must start with `https://`;
   plain `http://` is accepted only for `localhost`, `127.0.0.1` and `[::1]` (a model server on
   the same machine, any port). A user name or password in the URL is refused: put the key in the
   key field.
2. List the models, one per line: `name | label | flags | input $/M | output $/M`.
   - `name` is what the endpoint calls the model.
   - Flags: `tools` (the default), `no-tools` for a model that can't call functions, `reasoning`
     to offer the Low / Medium / High effort setting (sent as `reasoning_effort`).
   - Prices are US dollars per million tokens. Leave both out and the model is **unpriced**: its
     calls are recorded at $0, shown as "unpriced" in the usage tables, and don't count toward the
     spend caps. Set prices if you rely on the caps.
3. Paste the key (stored encrypted with `MAIL_TOKEN_KEY`, like the Anthropic key) or set the
   `OPENAI_API_KEY` Worker secret. **Test key** calls `GET <base URL>/models`. See "Which key is
   sent where" below.
4. Under **Models**, allow the new models, and pick a default model per feature if you like.
   The chat, scheduled jobs and Ask AI call tools, so they only list models with tool use. The
   assistant panel only offers allowed models whose provider has a key.

### Which key is sent where

A key is only sent to the address it belongs to.

- **The in-app key follows the host.** The key pasted in Settings → Assistant is saved for the host
  of the base URL saved at that moment. The key form carries the host the page showed; if the saved
  base URL changed since, the save is refused ("The base URL changed. Reload and try again.").
  Saving a base URL with a different host removes the in-app key before the new URL is stored;
  paste the key for the new address. Only the provider card changes the base URL: saving any other
  assistant setting keeps it exactly as saved, even when it is no longer usable. Until then the provider has no key, and **Test key** says the
  saved key is for a different address.
- **Host, not scheme.** The binding is the host with its port (`localhost:8443`), not the scheme.
  Only `localhost`, `127.0.0.1` and `[::1]` may use `http://`, so a key saved for
  `https://localhost:8443` is also sent to `http://localhost:8443`. A trailing dot or another port
  is a different host.
- **The Worker secret goes to one host.** `OPENAI_API_KEY` is sent only to `api.openai.com`, or to
  the host the operator names in the optional `OPENAI_BASE_URL_HOST` variable (a bare host such as
  `openrouter.ai`, or `host:port`; set it as a var or a secret). For any other base URL the secret
  is not used, and Test key says so.
- **The Anthropic key** (`ANTHROPIC_API_KEY` or the in-app one) only ever goes to Anthropic.
- **No redirects.** Requests to the base URL don't follow redirects. A 3xx answer is reported as an
  error, and nothing is sent to the address it points at.
- **Every feature says why.** When the provider has no key for the saved address, the chat, Ask AI,
  Draft reply, jobs, briefs, reports and resend subjects give the same reason as Test key.

### Upgrading

- A key saved before this version stays tied to the base URL that was saved with it. It is bound
  to that URL's host the first time it is read, or before any settings save, whichever comes first.
  If that URL was not the intended one, remove the key and enter it again.
- A saved base URL that is plain `http://` on another host stops working. No key is sent anywhere,
  not even the `OPENAI_API_KEY` secret, until it is fixed. Settings → Assistant shows the saved
  value so you can see what to change. Save a `https://` URL (or a localhost one) and paste the
  key again.
- An install that uses the `OPENAI_API_KEY` Worker secret with a base URL other than OpenAI's needs
  `OPENAI_BASE_URL_HOST` set to that host, or an in-app key.

### Spend caps

Every feature counts toward the assistant's spend caps (Settings → Assistant), resend subject
suggestions included. A suggestion is refused once the app's monthly or the user's daily cap is
reached. The cap is checked first, so a refused call doesn't use up the hourly limit.

Resend subject suggestions now store a small record of each answered call, like the other AI
features, so they count toward the caps. What is stored:

- a hidden assistant thread titled "Resend subject suggestion", with two fixed placeholder
  messages ("(resend subject request)" and "(suggestion returned to the composer)" or "(no usable
  suggestion)") plus the model, token counts and cost;
- a usage row (`ai_actions`, tool `resend_subject`) with the model, tokens and cost.

That is usage only: the subject you typed and the suggestion are never stored or logged. The
suggestion goes back to the form field and nowhere else. The History setting in Settings →
Assistant applies to the hidden thread like the rest of the assistant history, and the usage row is
kept 365 days, like the other assistant actions. Resend subject suggestions still only need the Settings → General switch, not
assistant access, and keep their limit of 20 per user per hour.

### Same rules for every provider

The assistant's rules are the same for every provider: there is no tool that sends, schedules,
activates or enrolls; writes go through the same approve / undo path; prompts, selections,
subjects and keys are never logged.

## Adding a provider

A provider is an adapter behind `AiProvider` in `src/lib/server/ai/provider.ts`:

```ts
interface AiProvider {
  stream(req: StreamRequest): AsyncIterable<ProviderEvent>;
}
```

The request and the events are provider-neutral. `ChatMessage.content` is a list of blocks —
`text`, `tool_use` (`id`, `name`, `input`), `tool_result` (`tool_use_id`, `content`, `is_error`)
and Anthropic's `thinking` blocks, which other adapters drop. That is also what `ai_messages.content`
stores, so stored conversations load under any provider. The stream yields `text` pieces,
`tool_use_start`, optional `tool_input` pieces, and ends with exactly one `done` (the final content
blocks, a stop reason — `end_turn`, `tool_use`, `max_tokens` — and `Usage`) or `error`.

Steps:

1. **Adapter.** A new module in `src/lib/server/ai/` that maps `StreamRequest` to the provider's API
   and its stream back to `ProviderEvent`s (see `openai-compat.ts`). Use `fetch` and the SSE parser
   in `$lib/sse` (no SDKs, it runs on Workers). Never log the request body or the key; scrub the key
   from any error message (`scrubKey`).
2. **Key.** Store it the way `src/lib/server/ai/key.ts` does: an `integration_secrets` row sealed
   with `MAIL_TOKEN_KEY`, a Worker secret fallback, and a case in `resolveProviderKey`. A new secret
   goes in `.dev.vars.reference` with an "Optional" comment.
3. **Registry.** Add the id to `PROVIDERS` / `PROVIDER_LABELS` in `src/lib/ai-models.ts` and a case
   in `providerFor` / `configuredProviders` (`src/lib/server/ai/providers.ts`). Its models are
   `ModelInfo` entries with `provider`, `apiModel`, `tools`, `streaming`, `efforts` and an optional
   `price`; ids are namespaced (`<provider>:<model>`). Built-in Claude entries keep their bare ids.
4. **Settings.** Let an admin enter the key and the models in Settings → Assistant, and add a row to
   the optional setup checks (`src/lib/server/setup-checks.ts`).
5. **Tests.** Cover the request body, the stream assembly (text, tool calls, usage, errors) and that
   the key never appears in logs or errors. The hard-rule tests in `tests/ai-providers-696.test.ts`
   run the assistant's tool registry against a fake provider; keep them passing.
6. **Evals.** Check the assistant against one of the new models with the eval suite
   ([assistant-evals.md](assistant-evals.md)). The runner (`scripts/assistant-evals.mjs`) calls
   Anthropic today; running it against another provider means giving it that provider's adapter and
   key, then recording the results like a Claude run.
