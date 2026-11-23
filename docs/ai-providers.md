# AI providers

The AI features (the assistant chat, scheduled jobs, Ask AI in the editor, Draft reply, account
briefs, the report builder's "Describe it" box and resend subject suggestions) reach a model through
one interface, so an install can use more than one provider. Claude (Anthropic) is the default and
the only provider an install needs.

## Using an OpenAI-compatible provider

Settings → Assistant → **Other providers: OpenAI-compatible** takes any endpoint that speaks the
OpenAI Chat Completions API with streaming (`POST <base URL>/chat/completions`, `stream: true`):

| Provider | Base URL |
| --- | --- |
| OpenAI | blank (`https://api.openai.com/v1`) |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` |
| Cloudflare Workers AI | `https://api.cloudflare.com/client/v4/accounts/<account id>/ai/v1` |
| A server you run | its OpenAI-compatible URL, reachable from the Worker |

1. Enter the base URL and, optionally, a name ("OpenRouter").
2. List the models, one per line: `name | label | flags | input $/M | output $/M`.
   - `name` is what the endpoint calls the model.
   - Flags: `tools` (the default), `no-tools` for a model that can't call functions, `reasoning`
     to offer the Low / Medium / High effort setting (sent as `reasoning_effort`).
   - Prices are US dollars per million tokens. Leave both out and the model is **unpriced**: its
     calls are recorded at $0, shown as "unpriced" in the usage tables, and don't count toward the
     spend caps. Set prices if you rely on the caps.
3. Paste the key (stored encrypted with `MAIL_TOKEN_KEY`, like the Anthropic key) or set the
   `OPENAI_API_KEY` Worker secret. **Test key** calls `GET <base URL>/models`.
4. Under **Models**, allow the new models, and pick a default model per feature if you like.
   The chat, scheduled jobs and Ask AI call tools, so they only list models with tool use. The
   assistant panel only offers allowed models whose provider has a key.

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
   goes in `.dev.vars.example` with an "Optional" comment.
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
