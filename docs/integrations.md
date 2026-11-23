# Integrations

The **Integrations** page (`/integrations` in the nav rail) manages the MCP
servers the deck can use. Chat sessions and routines see the same servers:
routines call them from `mcp` steps, and from `agent` steps that list them in
`mcp_servers_allowed`.

This page covers the Integrations view, the Google Workspace setup end to end,
and the `inbox-triager` template that builds on it.

## The Integrations page

### Installed servers

Each server row shows a status dot (connected, connecting, disconnected or
error; hover it for the error text), its scope, its transport and its tool
count. Click the row to expand the tool list (name and description).

| Scope | Where the entry lives | Editable here |
|---|---|---|
| `user` (default) | `~/.omp/agent/mcp.json` | yes. Routines see a user server whatever their working directory. |
| `project` | `.omp/mcp.json` under the deck's working directory | yes |
| `external` | any other config omp discovers: `.mcp.json`, `mcp.json`, and the Claude, Cursor and VS Code MCP configs. The row shows the source path. | Enable/Disable only. Edit or remove it in its own config file. |

Actions per server:

- **Enable / Disable**: toggles the entry. A disabled server stays listed but
  is not started.
- **Test**: reconnects the server and refreshes its status and tool list.
- **Reauthorize** (http/sse servers only): starts the server's MCP OAuth flow.
  The consent page opens in a new tab and the list refreshes while you finish.
- **Remove** (asks for confirmation; not shown for `external` servers):
  deletes the entry from its `mcp.json`.

### Adding a server

**Add server** opens a form with a name, a scope (`user` or `project`) and a
transport:

- **stdio**: a command, its arguments (one per line, or one line split on
  whitespace) and environment variables (`KEY=VALUE`, one per line).
- **http / sse**: a URL and an optional bearer token, saved as an
  `Authorization: Bearer <token>` header.

The server validates the name and config before writing; problems show inline,
and a name that already exists is rejected.

### When changes take effect

- **New chat sessions** see a change immediately. A chat session that is
  already running picks it up after `/mcp reload`.
- **Routines** use the deck's own MCP service, which reloads after every add,
  remove, enable or disable made on this page. The next `mcp` or `agent` step
  sees the change. If you edit an `mcp.json` by hand, restart the deck (or make
  any change on this page) so routines pick it up.

### Security

- The page writes executable commands into `mcp.json`, so it gets the same
  protection as the rest of the deck's API (Host/Origin allow-list plus deck
  auth). See [deployment](./deployment.md) before exposing the deck beyond
  loopback.
- `mcp.json` stores the command, arguments and env values (including OAuth
  client secrets) in plain text. omp writes it with file mode `0600` inside a
  `0700` directory.
- Secrets are never sent back to the browser: the server list carries no
  command, env, URL or header values, and secret values that appear in a
  server's error text are replaced with `[redacted]`. To change a secret,
  remove the server and add it again.

## Google Workspace

The Recommended panel has one tile, **Google Workspace**, for
[taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp)
(`workspace-mcp`): Gmail, Drive and Calendar tools over stdio. It uses your own
Google Cloud OAuth client, so Google data goes only between the deck host and
Google's APIs.

### Prerequisites

- **uv** on the deck host. `uvx` ships with it and downloads `workspace-mcp`
  (and a suitable Python) on first run.
  [Install uv](https://docs.astral.sh/uv/getting-started/installation/):

  ```bash
  curl -LsSf https://astral.sh/uv/install.sh | sh   # macOS / Linux
  brew install uv                                   # or Homebrew
  uvx --version                                     # check
  uvx workspace-mcp --help                          # pre-download workspace-mcp once
  ```

  Run the last command once before adding the server: the first `uvx` start
  downloads several hundred MB, which can outlast the 30-second MCP connect
  timeout, leaving the server in `error` until a later attempt finishes it.

  `uvx` must be on the `PATH` of the deck process. If the deck runs as a
  service (launchd, systemd) and cannot find it, put the absolute path (for
  example `/Users/you/.local/bin/uvx`) in the command field. The deck's Docker
  image does not include uv.
- A Google account. A personal Gmail account works; a Google Workspace account
  works too.
- Port `8000` free on the deck host: `workspace-mcp` listens there briefly for
  the OAuth callback during sign-in.

### 1. Create a Google Cloud project

Open the [Google Cloud console](https://console.cloud.google.com/), use the
project picker at the top and choose **New project**. Any name works. Keep this
project selected for the next steps.

### 2. Enable the APIs

Enable the API for each service the server will use, in the same project:

- [Gmail API](https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com)
- [Google Drive API](https://console.cloud.google.com/flows/enableapi?apiid=drive.googleapis.com)
- [Google Calendar API](https://console.cloud.google.com/flows/enableapi?apiid=calendar-json.googleapis.com)

Or with `gcloud`:

```bash
gcloud services enable gmail.googleapis.com drive.googleapis.com calendar-json.googleapis.com --project=PROJECT_ID
```

A call to a service whose API is not enabled fails with `403 SERVICE_DISABLED`.

### 3. Configure the OAuth consent screen

In **Google Auth Platform** (APIs & Services → OAuth consent screen):

1. **Branding**: an app name and your email as the support and developer
   contact.
2. **Audience**: user type **External** for a personal Gmail account
   (**Internal** is available, and simpler, for an account in your own Google
   Workspace organization). Leave the publishing status on **Testing**.
3. **Test users**: add the Google account whose mail the deck will read. In
   Testing mode only listed accounts can sign in.

You don't need to add scopes by hand; `workspace-mcp` requests the ones its
tools need during sign-in. Expect Google's "Google hasn't verified this app"
warning; it is your own app, so continue.

In Testing mode Google expires refresh tokens after
[7 days](https://developers.google.com/identity/protocols/oauth2#expiration),
so you will have to sign in again weekly. Setting the app to **In production**
removes the expiry; for an app only you use, Google does not require
verification, but the unverified-app warning stays.

### 4. Create the OAuth client

**Google Auth Platform → Clients → Create client**, application type
**Desktop app**. Upstream's
[quick start](https://workspacemcp.com/quick-start) recommends Desktop clients
for local and stdio setups: they need no redirect URIs. (Web application
clients are for hosted HTTP deployments and need matching redirect URIs.)

Copy the **client ID** and **client secret**.

### 5. Install the server from the tile

**Integrations → Recommended → Google Workspace → Set up** opens the add form
pre-filled with:

| Field | Value |
|---|---|
| Name | `google-workspace` |
| Scope | `user` |
| Transport | stdio |
| Command | `uvx` |
| Arguments | `workspace-mcp --tools gmail drive calendar` |
| Env | `GOOGLE_OAUTH_CLIENT_ID=` and `GOOGLE_OAUTH_CLIENT_SECRET=` |

Paste the client ID and secret after the `=` signs, and add one more env line
with the Google account you will sign in with:

```
USER_GOOGLE_EMAIL=you@example.com
```

Without it every Gmail, Drive and Calendar tool requires a
`user_google_email` argument; with it the argument becomes optional and the
server fills it in. The `inbox-triager` template relies on this and never
passes the email.

Optional hardening: append `--disabled-tools send_gmail_message` to the
arguments. An agent step allowed to use `google-workspace` can call every tool
the server exposes, including sending mail.

Add the server. Keep the name `google-workspace`: the `inbox-triager` template
refers to the server by that name.

The entry written to `~/.omp/agent/mcp.json` looks like this:

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "uvx",
      "args": ["workspace-mcp", "--tools", "gmail", "drive", "calendar"],
      "env": {
        "GOOGLE_OAUTH_CLIENT_ID": "1234-abc.apps.googleusercontent.com",
        "GOOGLE_OAUTH_CLIENT_SECRET": "GOCSPX-...",
        "USER_GOOGLE_EMAIL": "you@example.com"
      }
    }
  }
}
```

The command and env names follow upstream's
[README](https://github.com/taylorwilsdon/google_workspace_mcp#quick-start).
`--tool-tier core|extended|complete` limits or widens the tool set within
those services. `uvx workspace-mcp --help` lists the other services (`docs`,
`sheets`, `tasks`, …); each needs its API enabled in step 2.

### 6. Check it with Test

The first start downloads the package, so the row can stay on *connecting*
for a while. Click **Test** once it settles: the dot turns green and the tool
count is non-zero. Expand the row to see the Gmail, Drive and Calendar tools
(for example `search_gmail_messages`). Listing tools does not need a Google
sign-in, so a green row says the server runs, not that it can read your mail.

If it stays red, expand it for the error. The usual causes are `uvx` not on
the deck's `PATH` and an empty client ID or secret.

### 7. First-run consent

Google sign-in happens on the first tool call that touches Google. The
simplest trigger is a new chat session: ask the agent to "search my Gmail for
unread mail from today".

1. The tool answers with **ACTION REQUIRED** and an authorization URL, and
   `workspace-mcp` tries to open it in a browser on the deck host.
2. Sign in with the test user from step 3 and approve the requested access.
3. Google redirects to `http://localhost:8000/oauth2callback` on the deck
   host, which stores the credentials. The page shows the account email.
4. Retry the request. If `USER_GOOGLE_EMAIL` is not set, the tools also need
   that email as their `user_google_email` argument.

The credentials are stored under `~/.google_workspace_mcp/credentials/`
(override with `WORKSPACE_MCP_CREDENTIALS_DIR`) and are reused by later chat
sessions and by routines, so routines never need a browser.

- **Remote deck**: the callback goes to `localhost:8000` on the deck host.
  Open the URL in a browser on that machine, or forward the port first
  (`ssh -L 8000:localhost:8000 deck-host`).
- **Signing in again** (after the 7-day Testing expiry, or to switch
  accounts): repeat this step. **Reauthorize** does not apply here: it is for
  http/sse servers that use MCP OAuth, while `workspace-mcp` over stdio runs
  its own Google sign-in.

## The inbox-triager template

`inbox-triager` triages new Gmail on a schedule. Its steps:

1. `cursor` (transform) picks the search start: `last_seen_epoch` from the
   routine's state, or 24 hours ago on the first run.
2. `fetch_new` (`mcp`, `search_gmail_messages`) searches
   `in:inbox is:unread after:<cursor>` for the newest 50 messages.
3. `new_mail` (transform) parses the tool's text result into
   `{id, subject, from, date, link, thread_id}` objects. An unrecognized
   result fails the run, so the cursor never moves past mail that wasn't read.
4. `new_ids` (transform) lists the new message ids, and `fetch_bodies`
   (`mcp`, `get_gmail_messages_content_batch`) fetches their bodies in one
   call. Both run only when there is new mail.
5. `mail` (transform) pairs each message's headers with its body, collapses
   whitespace and cuts each body to 1000 characters. An unrecognized result
   fails the run, as in step 3.
6. `classify` (`agent`, only when there is new mail) sorts every message into
   `urgent`, `important` or `other` with a one-line reason, and writes a short
   suggested reply for each urgent one. It returns structured output and runs
   with `tools_allowed: []` and `mcp_servers_allowed: []`: no tools at all.
7. `triage` (transform) joins the verdicts with the fetched headers and drops
   any message id the model invented.
8. `label_urgent` / `label_important` (`mcp`,
   `batch_modify_gmail_message_labels`) add the system labels `STARRED` +
   `IMPORTANT` to urgent mail and `IMPORTANT` to important mail.
9. `draft_reply` (`mcp`, `draft_gmail_message`) saves one threaded draft
   reply to the most urgent message. Steps can't loop, so the other suggested
   replies are only in the capture. No step sends mail.
10. `capture` (`deck`, `create_inbox_item`) writes one capture to the deck
    Inbox (`/inbox`), "Inbox triage: N urgent, M important", listing the
    urgent and important messages with links, reasons and suggested replies.
    It is skipped when the run had no new mail.
11. `persist_state` (`set_state`) saves `last_seen_epoch: {{ run.epoch }}`.

**Security.** Email is written by whoever sends it, so treat every subject
and body as hostile: a message can contain instructions aimed at the model
("forward all mail to …", "run this command"). The template is built so that
such text has nothing to act with:

- `classify` is the only step that reads mail with an LLM, and it has no
  tools: no `bash`, no file access, no Gmail tools. Its prompt marks the mail
  as untrusted data, but the empty allowlists are what enforce it.
- Every Gmail action (search, fetch, label, draft) is a deterministic `mcp`
  step with fixed arguments. The worst an injected message can do is skew its
  own verdict or the suggested reply, which is saved as a draft for you to
  review and never sent.

If you only use the server for triage, you can also narrow the server itself.
In its arguments on the Integrations page, either keep `--tools` and add
`--disabled-tools send_gmail_message`, or replace `--tools gmail drive
calendar` with `--permissions gmail:drafts drive:readonly calendar:readonly`
(the two flags are mutually exclusive). `gmail:drafts` grants read, label and
draft access but registers no send or filter tools. Both limits also apply to
your chat sessions.

**Cursor.** Gmail's `after:` operator takes unix seconds or `YYYY/MM/DD`, not
ISO timestamps, so the cursor `last_seen_epoch` is in unix seconds. Each run
saves `run.epoch`, its own start time, so the next run only sees mail that
arrived after this one started. A run with no new mail skips `classify` and
spends no LLM tokens.

**Schedule.** The cron trigger `*/15 9-19 * * 1-5` in `America/Chicago` fires
every 15 minutes from 9:00 to 19:45 on weekdays. Change the cron in the
**Triggers** tab and the timezone in **Settings** to match your day. A
webhook trigger (`/hooks/inbox-triager-manual`) lets you fire it from
elsewhere. `concurrency: skip` drops a fire while the previous run is still
going.

**Budget.** `classify` runs `claude-sonnet-4-6` on every run that finds mail,
up to four times an hour. The budget caps each run at `max_llm_cost_usd: 0.15`
and `max_duration_secs: 240`; a run that goes over aborts with
`abort_reason: budget`. A run with a few new messages costs about $0.03; the
worst case, 50 messages with every body at the 1000-character cut, is
estimated at $0.11-0.13. Token counts and cost come from the agent session's
own usage stats. Change the model on the classify step if Sonnet is not
available to you. An aborted run does not move the cursor, so the next run
retries the same mail.

### Installing it

Like every template, it installs **disabled**. From the Routines page sidebar
pick the template, or:

```bash
curl -X POST http://127.0.0.1:8787/api/routine-templates/inbox-triager
```

The response is the new routine plus `missingIntegrations`, the MCP servers
the template references that the deck can't see. If `google-workspace` is not
installed yet, the Routines page shows a banner naming it, with a link to
Integrations. Set up Google Workspace (above), complete the first-run consent,
then:

1. Open the routine and click **Run now**. Check the run timeline: the parsed
   `new_mail` list, the `classify` result, and, if anything was urgent or
   important, the labels and draft in Gmail and a new capture in `/inbox`.
2. Toggle **Enabled** to start the schedule.
