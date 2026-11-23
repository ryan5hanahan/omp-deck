# Routines V1 — Tutorial

V1 routines are multi-step pipelines: a single routine can fetch data, run
an LLM against it, write the result somewhere, and persist a snippet of
state for the next run. Each routine can have multiple triggers (cron,
webhook, manual, event) and a budget cap. This walk-through gets you from
zero to a working daily-briefing in a few minutes.

## Quickest path: install the daily-briefing template

The fastest way to see a V1 routine in action:

```bash
# List shipped templates
curl http://127.0.0.1:8787/api/routine-templates

# Install one
curl -X POST http://127.0.0.1:8787/api/routine-templates/daily-briefing
```

That creates a routine in **disabled** state. Open the deck at
`/routines`, click the new entry, and you'll see the **Builder** tab with all
7 steps, the **Triggers** tab with its cron + webhook, the **Settings** tab
with the budget caps, and the **Spec (YAML)** tab with the raw spec.

To run it once on demand:

```bash
curl -X POST http://127.0.0.1:8787/api/routines/<id>/run
```

Or just click **Run now** in the editor. Once it's finished, the routine creates
a new **capture item in the deck's native Inbox** (`/inbox`, kind=`capture`).

## Author one yourself in the visual builder

1. Open `/routines` and click **New routine**.
2. The header shows two mode pills — **pipeline** (V1) and **single-action**
   (legacy V0). New routines default to pipeline.
3. **Settings** tab: set a name, optionally a description, concurrency,
   timezone, tags, and budget caps.
4. **Triggers** tab: add at least one trigger (cron / webhook / manual / event).
   Cron entries get a live "next 3 runs" preview against the IANA timezone
   you set.
5. **Steps** tab: click **+ Add step** and pick a type. Each card has the
   shared fields (`id`, `when`, `on_failure`, `retry`, `timeout_secs`) on
   top, then the type-specific fields underneath. Up/down arrows reorder.
6. Toggle **Enabled** in the footer, then **Create**.

The **Spec (YAML)** tab shows the same routine as raw YAML. Edit there and
click **Apply to form** to sync the changes back — useful for advanced
patterns the form doesn't expose (deeply nested transforms, complex
templating).

## The 9 step types

| type        | use                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------- |
| `run`       | shell out to a command, capture stdout/stderr                                            |
| `agent`     | run a headless omp agent session inside the deck; costs LLM tokens (see [Agent steps](#agent-steps)) |
| `write`     | write a templated string to a file (overwrite or append)                                 |
| `http`      | GET / POST / PUT / PATCH / DELETE against a URL; internal calls get an HMAC bearer token |
| `deck`      | mutate deck-native state without hand-rolling API calls (`create_inbox_item`, `create_task`, `move_task`, `promote_inbox_item_to_task`) |
| `transform` | JS expression in a quickjs sandbox (up to 1 s; `when:` guards and event filters get 100 ms); sets `steps.<id>.json` |
| `set_state` | UPSERT key/value pairs into the routine's persistent state                               |
| `wait`      | sleep N seconds (useful between polling steps)                                           |
| `mcp`       | call one tool on an MCP server the deck can see (`mcp.json` and other discovered configs); install servers on the [Integrations page](./integrations.md) |

Every step type has the shared fields:

- `id` — referenced by downstream steps via `steps.<id>.json`, `.stdout`, `.stderr`
- `when` — a JS expression evaluated in the sandbox; if it returns falsy, the
  step is skipped
- `on_failure` — `abort` (default), `continue`, `retry`
- `retry` — `{ times, backoff: linear | exponential, max_delay_secs?, after_retry? }`
- `timeout_secs` — per-step wall-clock cap

### Agent steps

An `agent` step runs inside the deck process as a headless omp session,
through the same SDK the chat uses. The session lives in memory (no session
file), and its final assistant text becomes the step's `stdout`.

- `skills_allowed`, `mcp_servers_allowed` and `tools_allowed` are enforced.
  Omitted means everything the deck can see, `[]` means none, and a list
  means only those names. A listed MCP server that isn't installed fails the
  step before any LLM call.
- `tools_allowed` names built-in tools (`read`, `grep`, `bash`, `edit`,
  `write`, `web_search`, ...). With it set, the session gets exactly those
  built-ins: no extension, memory or skill-management tools, and nothing the
  SDK would otherwise add on its own. MCP tools still follow
  `mcp_servers_allowed`, and `yield` stays available with `structured_output`.
  An unknown name fails the step before any LLM call, and the error lists the
  valid names. Without `tools_allowed` the session keeps the SDK's default
  tools, `bash` included.
- Give an agent step that reads untrusted input (email, web pages, issue
  text) `tools_allowed: []` and the narrowest `mcp_servers_allowed`, and do
  the side effects in deterministic `mcp`/`deck` steps after it. A prompt can
  tell the model what not to do, but only the allowlists stop it.
- With `structured_output`, the model returns its result through the `yield`
  tool and the value lands in `steps.<id>.json`. A run that never yields falls
  back to parsing the final text as JSON. Unless `strict: false`, a result
  that doesn't match the schema fails the step.
- Tokens and cost come from the session's own usage stats and count against
  the routine's [budget](#budget).

## Templating

The runner exposes a `{{ expr }}` template surface for string fields:

- `{{ run.id }}` — opaque run ID, prefixed `run_`
- `{{ run.date }}` — `YYYY-MM-DD` in the routine's timezone
- `{{ run.started }}` — ISO start timestamp
- `{{ trigger.kind }}` — `cron` | `manual` | `webhook` | `event`
- `{{ trigger.payload.<field> }}` — webhook body, manual params, or the event (see [Event triggers](#event-triggers))
- `{{ steps.<id>.json.<field> }}` — structured output (e.g. parsed HTTP response)
- `{{ steps.<id>.stdout }}` — captured stdout text
- `{{ state.<key> }}` — persisted state from prior runs (or `set_state` earlier this run)
- `{{ env.NAME }}` — non-sensitive environment variable
- `{{ secrets.NAME }}` — sensitive env var (any key marked sensitive in Settings → Env, or
  whose name contains KEY, TOKEN, SECRET, PASSW, CREDENTIAL, AUTH, COOKIE or PRIVATE).
  Sensitive vars are **not** in `env`. Their values (8+ chars) are replaced with
  `[REDACTED]` in every recorded step output, and read as `[REDACTED]` in `when:`/`transform`.

Helpers: `{{ steps.X.json | json }}` (JSON-stringify), `{{ items | length }}`.

In a single-expression payload (e.g. an HTTP body), the value is preserved
as its native type, not coerced to a string.

## Triggers

A routine can have multiple triggers, even of the same kind. Examples:

```yaml
trigger:
  - cron: "0 7 * * *"          # 7am daily
  - cron: "0 17 * * 1-5"       # 5pm weekdays
  - webhook:
      path: /hooks/refresh
      secret_env: REFRESH_SECRET
  - manual: {}
  - event:
      source: deck_task
      type: moved
```

Cron expressions are 5-field standard (minute / hour / day / month / weekday).
Set `timezone:` on the spec to evaluate against an IANA zone like
`America/Chicago`.

For webhook triggers, click **Rotate secret** in the routine's Settings tab
to mint a fresh server-side secret. The plaintext is shown **once** —
the server only persists a hash. Callers must sign the request body with:

```
X-Routine-Signature: sha256=<hex>
```

where `<hex>` is `HMAC-SHA256(secret, body)`.

A routine can have one webhook trigger, and a path belongs to one routine.
Saving a routine whose webhook path another routine already uses fails with
`409 {error, path, routine: {id, name}}` and saves nothing; the builder shows
the conflict on the webhook trigger. Installing a template whose path is
taken appends `-2`, `-3`, … instead.

### Event triggers

An `event` trigger fires the routine when something happens inside the deck:

```yaml
trigger:
  - event:
      source: deck_task
      type: moved                              # optional; omit to match every type
      filter: 'event.toStateId === "s_done"'   # optional
```

| `source` / `type` | Payload | Emitted when |
|---|---|---|
| `deck_inbox` / `created` | `{item}` | an inbox item is created (UI, slash command, API or a routine `deck` step) |
| `deck_task` / `moved` | `{task, fromStateId, toStateId}` | a task moves to another column; reordering within a column does not fire |
| `routine_finished` / `success`, `failed`, `aborted` | `{routineId, routineName, runId, status, abortReason?}` | a routine run ends |
| `telegram` / `message` | `{chatId, fromId, text}` | the Telegram bridge receives a message |

- `filter` is a JS boolean expression evaluated in the sandbox against
  `event = { source, type, ...payload }`, with a 100 ms cap. The routine
  fires only on a truthy result; an expression that throws counts as no
  match and is logged.
- The run gets the same object as its trigger payload, e.g.
  `{{ trigger.payload.task.title }}` or `{{ trigger.payload.text }}`.
- Loop guard: a routine is never triggered by its own events (from its own
  steps or its own `routine_finished`), and a chain of routines triggering
  routines stops at depth 3. Dropped events are logged as warnings.

## Concurrency

What happens when a trigger fires while a previous run is in flight:

- `skip` (default): drop the new fire
- `queue`: queue it; run after the current one finishes
- `cancel-previous`: abort the in-flight run, start the new one
- `parallel`: run concurrently (costs add up)

## Budget

`max_duration_secs`, `max_llm_cost_usd`, `max_llm_tokens_input`,
`max_llm_tokens_output`, `max_steps_executed`. Checked between steps. On
excess the runner hard-aborts with `abort_reason: 'budget'` and persists
partial results.

Agent-step tokens and cost come from the agent session's own usage stats
(the SDK's model pricing). Treat the cost as an estimate, not an invoice;
your LLM vendor's bill is authoritative.

## Cross-run state

Persistent key-value store scoped per routine:

```yaml
state:
  declared_keys: [last_seen_id]
steps:
  - id: should_run
    type: transform
    body: |
      if (state.last_seen_id === run.id) return { ok: false };
      return { ok: true };
  - id: do_thing
    type: run
    when: steps.should_run.json.ok
    command: ./script.sh
  - id: persist
    type: set_state
    state:
      last_seen_id: "{{ run.id }}"
```

`declared_keys` is informational — the runtime can write any key via
`set_state`. State writes are atomic per step.

## Observability

- Routine detail page → **Runs** section lists recent runs.
- Click a run → `/routines/:id/runs/:runId` opens **RunDetailView** with a
  live-polling timeline. Click any step to expand stdout / stderr /
  structured JSON / error.
- `GET /api/routines/:id/metrics` returns success rate, p50/p95 duration,
  MTD cost, and a last-30 sparkline series.

## Programmatic install

If you'd rather not click through the builder:

```bash
# Author the spec as a YAML file
cat > /tmp/my-routine.yaml <<'YAML'
name: hello-world
description: minimal one-step routine
trigger:
  - manual: {}
concurrency: skip
steps:
  - id: greet
    type: run
    command: 'echo "hello from {{ run.id }}"'
YAML

curl -X POST http://127.0.0.1:8787/api/routines \
  -H "content-type: application/json" \
  -d "$(jq -Rs '{ name: "hello-world", cron: "", actionKind: "bash", actionBody: "", specYaml: . }' < /tmp/my-routine.yaml)"
```

The server validates the YAML against the JSON Schemas in
`packages/protocol/src/schemas/` and returns 400 with a list of schema
errors if anything is off.

## V1.5 additions

- **`mcp` step**: calls one tool on an installed MCP server; the result lands
  in `steps.<id>.json`.
- **Integrations page** (`/integrations`): add, enable, test and remove MCP
  servers, with a Google Workspace tile (Gmail, Drive, Calendar via
  [taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp)).
  Setup guide: [Integrations](./integrations.md).
- **`inbox-triager` template**: Gmail triage every 15 minutes during work
  hours, on top of the Google Workspace server
  ([details](./integrations.md#the-inbox-triager-template)). Installing a
  template that needs an MCP server you don't have shows a banner linking to
  Integrations.
- **MCP-aware step forms**: the `mcp` step picks its server and tool from
  dropdowns and generates inputs from the tool's schema; agent steps suggest
  allowlist entries from installed servers and skills.
- **Drag-and-drop reorder**: drag a step card by its handle (the arrows still
  work). A move that makes a step read a later step's output shows a warning
  with **Revert**. **Duplicate** copies a step in place.
- **Event triggers**: routines fire on deck events; see
  [Event triggers](#event-triggers).
- **`max_parallel`**: caps concurrent runs under `concurrency: parallel`.
  Fires above the cap queue (depth 10).
- **Agent-step allowlists enforced in-process**: see
  [Agent steps](#agent-steps).

## Next (V2)

- A "test this step in isolation" runner. Until then a full re-run is the
  only way to debug a step.
