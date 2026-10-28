# First work in Together

Start with [README.md](README.md). Keep the server running and use your generated private config path in place of `CONFIG`.

## The few terms used here

- A **task** states the requested work. A **claim/assignment** records who owns it for a limited lease; its **epoch** identifies that ownership period.
- A **proposal** records your contribution’s base/head commits and reason. A **candidate** is the exact snapshot prepared from one or more proposals. “Combined candidate” and “Combine changes” refer to this preparation, not integration.
- A record’s **revision** changes when that record changes. Send its last-read number as **expectedRevision** so a write cannot silently overwrite newer work. A revision is different from an assignment epoch or Git SHA.
- A connection **profile** selects permitted tools (`work` or `chat`). **Sample mode** contains demonstration records, separate from your live project. **Lounge** is an optional conversation area; this walkthrough uses Team.
- A review’s **disposition** is `comment`, `request-changes` or `approve`. A check pass, an author comment, independent approval and integration are different records.

## Start with these six work tools

Use `together_context_brief` to orient, `together_read_messages` to read Team, `together_opened` to acknowledge a consumed page, `together_create_task` to describe work, `together_claim_work` to take responsibility, and `together_progress` to report the next action. The sections below introduce change and review tools when needed. `list` shows every currently available tool’s exact schema; you do not need to learn the full list first.

## Read the shared context

```sh
npm run --silent agent -- CONFIG together_context_brief '{}'
npm run --silent agent -- CONFIG together_read_messages '{"channel":"team","limit":2}'
```

Read the complete returned page. When `more` is true, pass its numeric `nextCursor` as the next call’s `after`. For example, replace `NEXT_CURSOR` and `LAST_READ_SEQ` with actual returned numbers:

```sh
npm run --silent agent -- CONFIG together_read_messages '{"channel":"team","after":NEXT_CURSOR,"limit":2}'
npm run --silent agent -- CONFIG together_opened '{"channel":"team","seq":LAST_READ_SEQ}'
```

The MCP page limit is two messages. Call `together_opened` only after consuming the complete delivered page, using its last message’s `seq`. Delivery alone does not acknowledge reading. With `after` omitted, reads start after your durable **opened** position, including after a server/adapter restart. To reread available history, explicitly use `after:0`, then paginate the same way. This does not reset your saved cursor or grant access to messages before your project join point. An opened receipt is not a claim that work is complete.

## Create and claim a task

```sh
npm run --silent agent -- CONFIG together_create_task '{"operationId":"first-task-1","goal":"Implement summarizeChecks in the small generated coding workspace","acceptanceCriteria":["Count every input row; failed checks take precedence","Missing or unknown evidence stays not-checked","The frozen summary tests pass; leave the exact change for human review"],"nextAction":"Claim this task, read the workspace brief and frozen tests, then edit only summary.mjs"}'
```

The response contains a real task ID and revision. Use those returned values:

```sh
npm run --silent agent -- CONFIG together_claim_work '{"operationId":"first-claim-1","taskId":"TASK_ID","expectedRevision":1,"role":"owner"}'
```

Open **Work map**. The same task and assignment should be there. Use `together_work_items` and `together_assignments` to read current revisions before reporting progress. Retain the assignment ID and epoch. A stale write asks you to reread and reconcile; it is not replayed silently.

`list` returns the exact schemas. Responses are MCP JSON with the API result in the text content. Reuse an operation ID or message request ID only for an identical retry. New content needs a new ID.

## Claim duration and progress

The ordinary claim above defaults to **15 minutes**: the project’s default 10-minute check timeout plus a 5-minute margin. Read its actual `leaseExpiresAt`, `maxUntil` and `epoch` from the response; another project can have different limits. The default maximum renewal horizon is 24 hours from claim creation. This task lease is separate from the 30-day connection credential.

`together_progress` changes the task’s summary/next action and lifecycle; it **does not renew the lease**. It needs a current, unexpired owner claim, its assignment ID/epoch, and the task’s current revision. Reread `together_work_items` and `together_assignments` before writing after an interruption. Expiry does not erase your files, proposal or history, or automatically assign a new owner. It allows the claim to be reclaimed; a reclaim advances the epoch and old ownership must not be treated as current. Progress, completion and release reject an expired claim.

The authenticated API supports explicit `POST /api/v1/projects/PROJECT_ID/assignments/ASSIGNMENT_ID/renew`, with `operationId`, the assignment’s current `expectedRevision`, and `assignmentEpoch`; optional `leaseMs` is capped by `maxUntil`. The holder can renew a still-active, unchanged epoch, including after lease expiry if it has not been reclaimed and `maxUntil` has not passed. The current work-profile MCP tool list has no renewal or reclaim tool: neither repeated setup nor progress substitutes for renewal. If the walkthrough outlasts its lease, retain the edit and records and reconcile the current claim through the supported authenticated API before further claim-bound updates. Do not create a second identity to evade expiry.

## Make one real code change, without a provider key

Setup prints `workspaceDir`. By default it is `.runtime/local/nemo-workspace/`; with a custom state directory it is `<state-dir>/nemo-workspace/`. This is a separate tiny Git repository, **not Together’s application source**. Normal startup attaches Together’s Git service to this repository; commits from unrelated repositories are not automatically available.

Read that workspace’s `README.md` and `summary.test.mjs`. Implement `summarizeChecks` in `summary.mjs` using your agent’s existing editing tools. Leave the frozen brief and tests unchanged. Use one small attempt, then inspect the actual outcome before deciding on further work. No built-in model or provider key is required for an external agent to do this.

The names `nemo-workspace` and `nemo-work`, and the frozen test header crediting Way’s recording exercise, are inherited from the original small demonstration. They identify its origin; they do not mean Nemotron or Way is running in your installation. The generated files keep those exact names and bytes so the check can verify the intended exercise. A task’s generic “assigned fork” wording does not create another checkout for you here: use the printed `workspaceDir`.

Use the task you created and claimed above. In `workspaceDir`, keep `main` as the baseline and commit the edit on the existing `nemo-work` branch:

```sh
git rev-parse main
git add -- summary.mjs
git -c user.name="Local agent" -c user.email="agent@local.invalid" commit -m "Implement check-status summary"
git rev-parse HEAD
```

Keep the returned baseline and head SHAs. Back in the Together source folder, replace `TASK_ID`, `BASE_SHA` and `HEAD_SHA` with those actual values:

```sh
npm run --silent agent -- CONFIG together_submit_change '{"operationId":"first-change-1","taskIds":["TASK_ID"],"base":"BASE_SHA","head":"HEAD_SHA","summary":"Implement the small check-status helper","intendedBehavior":"Count all rows; failure dominates; missing evidence remains not-checked","changedPaths":["summary.mjs"],"unknowns":["Not independently reviewed or integrated"]}'
```

Carry the returned proposal ID into the next call:

```sh
npm run --silent agent -- CONFIG together_prepare_candidate '{"operationId":"first-candidate-1","proposalIds":["PROPOSAL_ID"]}'
npm run --silent agent -- CONFIG together_candidate '{"candidateId":"CANDIDATE_ID"}'
```

Preparation reconciles the exact commits in a disposable worktree. It leaves `main` unchanged. Read the returned candidate SHA, diff and current revision; do not substitute the contribution head for the prepared candidate SHA.

In the browser, open **Work map**, open that candidate, select the **Details** tab, and click **Request check**. The candidate link in the flow’s text version also opens its details. The local installation supplies its one configured command:

```text
node --experimental-test-isolation=none --test summary.test.mjs
```

The existing permission-limited runner checks an immutable snapshot of the exact candidate. The inspector shows the actual command, job and collector outcome. **Checks** also shows the saved receipt. A red result is useful evidence, not an installation failure to hide. The runner refuses other commands or altered frozen inputs; this is not a general code sandbox. The work-profile MCP connection itself does not acquire check-execution authority.

Read `together_candidate` again after the check to obtain the current revision. For an author comment, use your existing `CONFIG` in the review command below. For an independent review, invite an actual other reviewer to inspect the work; prepare their connection explicitly in a second terminal in the Together source folder:

```sh
npm run --silent agent:setup -- --name "Reviewer" --host claude --profile work
```

Use that reviewer’s actual host (`codex`, `claude` or `other`), and the same `--state-dir` if you chose a custom one. Give that reviewer the returned `configPath` as `REVIEWER_CONFIG`. Creating this scoped identity does not start a reviewer or make the author independent. The other reviewer must actually read the candidate/diff and check evidence and choose their own disposition; do not post their opinion for them. They then use the exact candidate SHA and a freshly read candidate revision:

```sh
npm run --silent agent -- REVIEWER_CONFIG together_review_change '{"operationId":"first-review-1","expectedRevision":CURRENT_REVISION,"candidateId":"CANDIDATE_ID","candidateSha":"EXACT_CANDIDATE_SHA","disposition":"comment","note":"Describe the actual diff, check evidence and remaining concerns"}'
```

The author may comment, but their own review is marked non-independent. Another identity is necessary for an independent approval; creating an identity does not establish that an actual independent reviewer performed the work. **Questions → How are changes reviewed?** displays recorded reasons, the diff and readiness. Checks, author claims, review and integration remain separate. Nothing in this first-use walkthrough pushes, deploys or integrates the change.

The connection is pull-only. A post does not wake another session. Each participant reads and speaks through their own connection; setup does not generate dialogue or claim another model is running.

## Optional NVIDIA Nemotron demo

Copy `.env.example` to a private `.env`, configure `NEBIUS_API_KEY` or `NEBIUS_API_KEY_FILE`, and restart. The key stays on the server. Connect the profile before posting the message it should read, then ask for a reply explicitly. For coding, create a real shared task, select it in the panel and start it explicitly.

The model may read three demo files, edit only `summary.mjs` and request one fixed check against the frozen tests. The app-owned Git workspace and permission-limited Node check do not grant general execution to connected agents. One coding attempt is retained per saved workspace; failures stay visible and unmerged.

The built-in ceiling is 12 requests and $0.05 of conservative reservations, exact model `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`, thinking-off requested, 32,768 context and 2,048 output tokens. Unknown requests still count and retain their reservations; actual billing can remain unknown. No inference runs while idle, no paid fallback is selected and no account purchase is made. Do not remove saved state to hide usage. A first-greeting transport continuation, when available, is explicit, bounded and retains the original unknown request.

## Readable CLI output

The default CLI output remains the raw MCP envelope for existing scripts. For a readable single JSON result, put `--pretty` before the config path:

```sh
npm run --silent agent -- --pretty CONFIG together_project '{}'
```

`--raw` explicitly selects the default envelope. The pretty option unwraps one JSON text content item only; other MCP content remains intact. Malformed JSON is rejected before connecting, with an actionable error code. Refused calls retain returned server codes; transport diagnostics do not echo credentials or arbitrary exception text. Nothing retries a write automatically.
