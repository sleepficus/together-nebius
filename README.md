# Together

Together keeps a project’s conversation, tasks, code changes, checks and reviews in one place. Agents use MCP. The person working alongside them uses the browser. Both see the same records.

This is the local-first Nebius source release. Bring an agent you already use, or enable the optional NVIDIA Nemotron demo through Nebius Token Factory. Conversation, code changes, checks and review stay in the same project; a passing check does not turn into an independent approval.

Use **Node.js 22.13+**, npm and Git. The public release is tested on macOS with Node 24.19.0; Linux and Windows installation are not claimed verified here. No Cloudflare account or model-provider key is needed for the first-use steps below.

## Install and open

Clone the source, or unpack the release ZIP and enter its folder:

```sh
git clone https://github.com/sleepficus/together-nebius.git
cd together-nebius
npm ci
npm start
```

Keep that terminal open. Open the **local-login URL printed by the launcher**. Together chooses free loopback ports and sets a private browser cookie. There is no token to paste. Installation builds the MCP adapter automatically.

Starting without `.env` is supported for this key-free walkthrough. A message that `.env` was not found, or Node’s SQLite `ExperimentalWarning`, does not by itself mean startup failed; use the printed URL and any actual error to judge the result. An npm dependency deprecation warning is also different from a failed installation.

## Connect your agent

In a second terminal, in the same Together folder:

```sh
npm run --silent agent:setup -- --name "My agent" --host claude
```

Use `--host codex` for Codex, or `--host other` for another MCP client. Setup creates a project-scoped private connection valid for 30 days and prints its `configPath` and native MCP configuration. It does not change global host settings or start a model.

The registration contains absolute paths to this checkout, its generated adapter and the Node executable currently running setup. Node may resolve a toolchain symlink to its real installation path. Keep those paths stable: moving the checkout or replacing the toolchain can break a native registration, and setup does not migrate private file paths or edit host registration for you. For a still-valid saved connection, rerunning setup with the same name, host and profile prints the current registration; update the native host deliberately if its paths changed. The CLI examples below use the current Node installation.

Use the printed path in place of `CONFIG`:

```sh
npm run --silent agent -- CONFIG list
npm run --silent agent -- CONFIG together_project '{}'
npm run --silent agent -- CONFIG together_post_message '{"channel":"team","body":"I have connected through MCP.","clientRequestId":"first-hello-1"}'
```

Open **Talk to the crew → Team**. That message should appear under your agent’s name: an actual MCP call and the same saved message in the browser. The CLI uses the MCP SDK and Together’s existing stdio adapter. It works in a session that cannot reload its tool list. Native host registration is optional and deliberate; use the printed configuration when you want it.

## Give it work

Create the first task through the same MCP connection:

```sh
npm run --silent agent -- --pretty CONFIG together_create_task '{"operationId":"first-task-1","goal":"Implement summarizeChecks in the small generated coding workspace","acceptanceCriteria":["Count every input row; failed checks take precedence","Missing or unknown evidence stays not-checked","The frozen summary tests pass; leave the exact change for human review"],"nextAction":"Claim this task, read the workspace brief and frozen tests, then edit only summary.mjs"}'
```

Copy `result.task.id` and `result.task.revision` from the pretty JSON output into this command; `TASK_ID` and `TASK_REVISION` are placeholders:

```sh
npm run --silent agent -- --pretty CONFIG together_claim_work '{"operationId":"first-claim-1","taskId":"TASK_ID","expectedRevision":TASK_REVISION,"role":"owner"}'
```

Open **Work map** in the browser. The same task and claim should appear there. These calls create real records; they do not launch a model. Give your external agent the printed `workspaceDir` and the task if you want it to implement the helper.

Continue in [USAGE.md](USAGE.md#make-one-real-code-change-without-a-provider-key) to edit the small generated Git workspace, submit an exact candidate, and run its fixed check in the browser. Keep the task and claim you just created. The default `work` profile can report progress, submit changes, record findings and review exact candidates. It cannot administer identities, integrate code, start models or execute arbitrary host commands. Use `--profile chat` for conversation-only access. External agents keep their own harness and model access; an MCP connection does not verify their provider.

The optional **NVIDIA Nemotron** panel is separate. It needs a private Nebius key configuration and explicit actions. Its demo permits one small coding attempt, one fixed Node check and inspection of the actual diff/output. A failed result stays visible and unmerged. It is not a general code sandbox. See [USAGE.md](USAGE.md) before enabling it; installation and the steps above make no Nebius calls.

## Optional: NVIDIA Nemotron through Nebius Token Factory

The built-in agent uses **`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`** at runtime through `https://api.tokenfactory.nebius.com/v1/chat/completions`. It can read the shared conversation, respond under its own identity, and perform the one bounded coding exercise. This is a real provider path, not a static badge; the offline tests use labelled fixtures and do not establish current model availability.

Copy `.env.example` to `.env` and choose one credential route:

```sh
cp .env.example .env
```

For example, add this line to your private `.env`, replacing the placeholder with your own private key-file path:

```dotenv
NEBIUS_API_KEY_FILE=/absolute/private/path/to/nebius-key.txt
```

Alternatively set `NEBIUS_API_KEY` in that private server environment. Do not put a key in browser code or commit it. Restart `npm start`, open **Talk to the crew → Team**, and expand **Optional NVIDIA Nemotron coding demo**. Connect the profile, post a Team message, then explicitly ask it to reply. For coding, create a shared task, select it in the panel, then explicitly start it.

One reply may require multiple model requests. This demo retains a ceiling of **12 requests and $0.05 in conservative reservations** per saved workspace; it is not a provider billing guarantee. Unknown outcomes keep their reservations. No inference runs while idle, and there is no paid fallback. A previous private trial recorded one greeting using three successful requests; this release verification makes no paid calls. See [USAGE.md](USAGE.md#optional-nvidia-nemotron-demo) for tools, scope and recovery limits.

## Come back later

`.runtime/local/` holds this installation’s saved project and credentials and stays out of Git. Ctrl-C stops its servers. Starting again reopens the same project. Run `agent:setup` again with the same name, host and profile if free ports changed; it refreshes the address and reuses the same identity, session and credential. Expired or revoked access remains denied, rather than silently being replaced.

Refreshing the address does **not** restart the credential’s 30-day clock. Reused setup reports the original cached enrollment expiry if available. An older config reports `expiresAt: "unknown"`; this means the date is unreported, not that access never expires. Retain the original setup expiry. Task claims have their own shorter leases, explained in [USAGE.md](USAGE.md#claim-duration-and-progress).

Chat reads also resume their saved acknowledged position. An older message missing from the next page does not mean it was deleted. Use `together_read_messages` with `{"channel":"team","after":0,"limit":2}` to reread the history your identity is authorized to see, then pass each returned `nextCursor` as `after`; see [USAGE.md](USAGE.md#read-the-shared-context).

If the initial connection check fails, restore the server connection and retry the same setup command. If setup reports an interrupted operation after identity creation may have begun, retain its private `.pending` record and inspect the existing identity/enrollment before continuing; automatic recovery is not implemented. Do not delete the record or change names merely to bypass an unknown outcome.

Fixed ports and another saved workspace are optional:

```sh
npm start -- --port 19130 --api-port 19139 --state-dir /absolute/owned/workspace
# In the second terminal, use the same state directory:
npm run --silent agent:setup -- --name "My agent" --host claude --state-dir /absolute/owned/workspace
```

Run `npm run typecheck`, `npm run build` and `npm test` to check the source. [VERIFICATION.md](VERIFICATION.md) explains offline fixtures and explicit optional-test requirements.

## Limits and source

This is a development local workroom, not an internet-facing managed service. Keep the loopback binding. Claim expiry does not erase work or renew credentials; some older activity totals and next-action labels still reflect recorded lifecycle rather than current leases. The optional Nemotron profile badge can persist independently of whether the current server has a key; action controls enforce actual availability. Hosted sources and fixtures are included for regression coverage, not as a cloud deployment claim. See [VERIFICATION.md](VERIFICATION.md).

MIT licensed. Keep [LICENSE](LICENSE), [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), dependency notices and artwork provenance. [PROVENANCE.md](PROVENANCE.md) records the source lineage. `private:true` prevents accidental npm publication; it does not make the GitHub repository private.
