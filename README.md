# 🦞 Lobster

![Lobster banner](docs/assets/readme-banner.jpg)

An OpenClaw-native workflow shell: typed (JSON-first) pipelines, jobs, and approval gates.

Forked from [https://github.com/openclaw/lobster](https://github.com/openclaw/lobster)

| Source | Version |
|--------|---------|
| source | [![source version](https://img.shields.io/npm/v/%40clawdbot%2Flobster?label=npm)](https://www.npmjs.com/package/@plateforme-ai/lobster) |
| synced | [![synced version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fplateforme-ai%2Flobster%2Fmain%2Fpackage.json&query=%24.version&label=npm&prefix=v)](https://github.com/plateforme-ai/lobster/tree/main) |
| released | [![released version](https://img.shields.io/npm/v/%40plateforme-ai%2Flobster?label=npm)](https://www.npmjs.com/package/@plateforme-ai/lobster) |

## Example of Lobster at work

OpenClaw (or any other AI agent) can use `lobster` as a workflow engine and avoid re-planning every step — saving tokens while improving determinism and resumability.

### Watching a PR that hasn't had changes

```
node bin/lobster.js "workflows.run --name github.pr.monitor --args-json '{\"repo\":\"openclaw/openclaw\",\"pr\":1152}'"
[
  {
    "kind": "github.pr.monitor",
    "repo": "openclaw/openclaw",
    "prNumber": 1152,
    "key": "github.pr:openclaw/openclaw#1152",
    "changed": false,
    "summary": {
      "changedFields": [],
      "changes": {}
    },
    "prSnapshot": {
      "author": {
        "id": "MDQ6VXNlcjE0MzY4NTM=",
        "is_bot": false,
        "login": "vignesh07",
        "name": "Vignesh"
      },
      "baseRefName": "main",
      "headRefName": "feat/lobster-plugin",
      "isDraft": false,
      "mergeable": "MERGEABLE",
      "number": 1152,
      "reviewDecision": "",
      "state": "OPEN",
      "title": "feat: Add optional lobster plugin tool (typed workflows, approvals/resume)",
      "updatedAt": "2026-01-18T20:16:56Z",
      "url": "https://github.com/openclaw/openclaw/pull/1152"
    }
  }
]
```

### And a PR that has a state change (in this case an approved PR)

```
 node bin/lobster.js "workflows.run --name github.pr.monitor --args-json '{\"repo\":\"openclaw/openclaw\",\"pr\":1200}'"
[
  {
    "kind": "github.pr.monitor",
    "repo": "openclaw/openclaw",
    "prNumber": 1200,
    "key": "github.pr:openclaw/openclaw#1200",
    "changed": true,
    "summary": {
      "changedFields": [
        "number",
        "title",
        "url",
        "state",
        "isDraft",
        "mergeable",
        "reviewDecision",
        "updatedAt",
        "baseRefName",
        "headRefName"
      ],
      "changes": {
        "number": {
          "from": null,
          "to": 1200
        },
        "title": {
          "from": null,
          "to": "feat(tui): add syntax highlighting for code blocks"
        },
        "url": {
          "from": null,
          "to": "https://github.com/openclaw/openclaw/pull/1200"
        },
        "state": {
          "from": null,
          "to": "MERGED"
        },
        "isDraft": {
          "from": null,
          "to": false
        },
        "mergeable": {
          "from": null,
          "to": "UNKNOWN"
        },
        "reviewDecision": {
          "from": null,
          "to": ""
        },
        "updatedAt": {
          "from": null,
          "to": "2026-01-19T05:06:09Z"
        },
        "baseRefName": {
          "from": null,
          "to": "main"
        },
        "headRefName": {
          "from": null,
          "to": "feat/tui-syntax-highlighting"
        }
      }
    },
    "prSnapshot": {
      "author": {
        "id": "MDQ6VXNlcjE0MzY4NTM=",
        "is_bot": false,
        "login": "vignesh07",
        "name": "Vignesh"
      },
      "baseRefName": "main",
      "headRefName": "feat/tui-syntax-highlighting",
      "isDraft": false,
      "mergeable": "UNKNOWN",
      "number": 1200,
      "reviewDecision": "",
      "state": "MERGED",
      "title": "feat(tui): add syntax highlighting for code blocks",
      "updatedAt": "2026-01-19T05:06:09Z",
      "url": "https://github.com/openclaw/openclaw/pull/1200"
    }
  }
]
```

## Goals

- Typed pipelines (objects/arrays), not text pipes.
- Local-first execution.
- No new auth surface: Lobster must not own OAuth/tokens.
- Composable macros that OpenClaw (or any agent) can invoke in one step to save tokens.

## Quick start

From this folder:

- `pnpm install`
- `pnpm test`
- `pnpm lint`
- `node ./bin/lobster.js --help`
- `node ./bin/lobster.js doctor`
- `node ./bin/lobster.js "exec --json --shell 'echo [1,2,3]' | where '0>=0' | json"`

### Notes

- `pnpm test` runs `tsc` and then executes tests against `dist/`.
- `bin/lobster.js` prefers the compiled entrypoint in `dist/` when present.

## Commands

- `exec`: run OS commands
- `exec --stdin raw|json|jsonl`: feed pipeline input into subprocess stdin
- `where`, `pick`, `head`: data shaping
- `json`, `table`: renderers
- `approve`: approval gate (TTY prompt or `--emit` for OpenClaw integration)

## Durable OpenClaw Runtime Store

This package persists OpenClaw-oriented run history in SQLite using Node's built-in `node:sqlite` runtime. Checkpoint capture is always on; the store location defaults to `<LOBSTER_DIR>/lobster.db` and can be overridden:

```txt
LOBSTER_DIR=~/.lobster
```

The SQLite store is the single source of truth. It owns durable job, run, checkpoint, approval, cache index, and blob metadata records. The `checkpoints` table is an append-only log per run; resume and rewind state are derived by folding that log (no JSON resume/approval side files). Each waiting gate carries its executable resume context in `resume_state_json` on that checkpoint row, and resume tokens encode the waiting `checkpointId`. Jobs, workflow runs, checkpoints, and approval history are retained by default so OpenClaw can list jobs, inspect step history, rerun from the start, and rewind from supported checkpoints.

The schema is a fresh v1 stamped via `PRAGMA user_version`; there is no in-place migration path, so a database created by an older, incompatible schema is discarded and recreated (existing jobs/checkpoints do not carry over).

Runtime identifiers use these meanings:

- `jobId`: one customer/root request.
- `runId`: one concrete workflow invocation. A nested workflow gets its own `runId`.
- `rootRunId`: the root workflow invocation for the job.
- `parentRunId`: the caller workflow invocation for nested workflows.
- `stepPath`: stable nested path, for example `root.review.childStep`.

Commands inside a workflow `pipeline:` step emit checkpoints under that workflow step's path. For example, a workflow step `summarize` running `llm.invoke` records the outer step at `root.summarize` and inner pipeline checkpoints such as `root.summarize.llm.invoke` and `root.summarize.pipeline-output`.

Nested workflows share the same `jobId` and get separate child `runId` rows. Child workflow approval/input waits bubble up to the caller envelope and resume through a persisted call stack, so approving a child workflow can continue the child and then the parent workflow.

Current rewind support is strongest for linear root and child workflow checkpoints. Rewind inside `parallel`, `for_each`, or command-level pipeline suspension may return `replay_not_supported` until those replay boundaries are fully captured.

Cache entries are stored as TTL-managed SQLite rows. Small cache payloads are stored inline; larger cached inputs/outputs are written as content-addressed blobs under `LOBSTER_DIR/blobs/` and referenced from SQLite.

Useful cache settings:

```txt
LOBSTER_CACHE_TTL_DAYS=30
LOBSTER_CACHE_INLINE_MAX_BYTES=65536
```

Public dashboard/plugin APIs are exported from `@plateforme-ai/lobster/core`:

- `getJob({ jobId })` fetches durable job status, including `control` (`{ stepMode, desired, updatedAt? }`), `wait` (the current head blocker: `pause`, `approval`, `input`, or `null`), and optional job metadata (`title`, `description`, `metadata`).
- `getRun({ runId })` fetches durable run status, including `control` resolved from the job root run.
- `listJobs({ status, limit, cursor })` returns cursor-paginated dashboard job rows, including `control`, `wait`, and optional job metadata (`title`, `description`, `metadata`).
- `listJobRuns({ jobId })` returns root and nested workflow invocations for a job, including `control` on each run.
- `listPendingApprovals({ jobId, runId, limit, cursor })` powers global or job-scoped approval inboxes. Scoped calls return only the current head approval for that job/run.
- `listJobCheckpoints({ jobId })`, `getCheckpointIO({ checkpointId })`, `rerunToolRequest({ jobId })`, and `rewindToolRequest({ jobId, checkpointId })` complete the inspect/rerun/rewind dashboard flow.

### Run control (pause / cancel / step-by-step)

Long workflow-file runs can be controlled cooperatively. The runtime checks a persisted control record at each step boundary, so mid-step control requests are honored between steps (the currently running step is not interrupted, except best-effort via the existing `AbortSignal`). Control state lives in the `run_controls` table and is keyed by `runId`; resolving a `jobId` targets its root run.

- `runToolRequest({ filePath, stepMode: true })` starts a run that pauses before each step. The run immediately returns `status: "paused"` before the first step executes, with a `paused` payload `{ stepId, stepIndex, nextStepId, resumeToken, reason }` (`stepIndex: 0` for the first step). Each `resume` then runs exactly the pending step and pauses before the next. Nested workflows inherit this: a freshly entered child pauses before its own first step.
- `pauseRun({ jobId })` / `pauseRun({ runId })` requests a one-shot pause at the next step boundary. Pause only applies to **in-flight** runs (`status: "running"`). **At a wait gate** (the job is already `waiting` on `pause`, `approval`, or `input`) it returns `already_waiting` and does not set `control.desired` — the run is already suspended; use `continue` (pause gates) or `resume` (approval/input) instead.
- `cancelRun({ jobId })` cancels the run. **At a wait gate** (the job is `waiting` on a `pause`, `approval`, or `input`) cancel takes effect **immediately**: the job transitions to `cancelled`, the head waiting gate checkpoint is transitioned to `cancelled`, a terminal `control`/`cancelled` checkpoint is appended, any pending approval is cancelled, and the resume state is cleaned up — no `continue`/`resume` is required. The envelope returns `status: "cancelled"`. **Mid-step** (a step is in flight) cancel is cooperative: it sets `control.desired = "cancel"`, the envelope returns `status: "ok"`, and the run cancels at the next step boundary. `getJob().control.desired` exposes the pending `"cancel"` intent (render as "cancelling…" in a UI) until the boundary is reached.
- `setStepMode({ jobId, stepMode })` toggles sticky step-by-step mode.
- `getJob` / `getRun` / `listJobs` / `listJobRuns` expose the current run control snapshot as `control` (`{ stepMode, desired, updatedAt? }`), resolved from the job root run. `getJob` / `listJobs` also expose `wait`, the current head blocker for dashboard controls.
- Continue a paused run by calling `resumeToolRequest({ token })` with the `paused.resumeToken` (no `approved`/`response` needed). In step mode each resume advances exactly one step.
- Continue without a token by passing `resumeToolRequest({ jobId })` (or `{ runId }`). With no `approved` or `response`, this is a pause-only continue: core resolves the current head `pause` checkpoint and advances it. If the job is waiting on approval or input, it returns `no_resumable_state`; approval/input gates must use `approvalId` or `token` with `approved`/`response`. `argsPatch` and `approvedPayloadOverride` work the same as the token path.
- Rejecting an approval (`resumeToolRequest({ token, approved: false })` or `--approve no`) cancels the run and appends the same terminal `control`/`cancelled` checkpoint as `cancelRun`; the approval record is marked `rejected` (vs `cancelled` for `cancelRun`).

> `paused` is a non-terminal status (resumable). Terminal statuses are `ok`, `cancelled`, and errors. The CLI exposes `lobster pause --job <id>`, `lobster cancel --job <id>`, and `lobster step-mode --job <id> --on|--off`. Cancel is performed via `lobster cancel --job <id>` (which calls `cancelRun`); `lobster resume` no longer accepts `--cancel`.

### Editable inputs (rewind / rerun / resume)

- `rewindToolRequest({ jobId, checkpointId, inputOverride })` re-executes the targeted step and every step after it; steps strictly before the target are preserved from the prior run. `inputOverride` is an object keyed by `stepId` whose values are shallow-merged into a **preserved prefix step's** result before replay, so the re-executed target and downstream steps observe the edited upstream outputs. A `stepId` that is the target, downstream of it, or unknown returns `invalid_input_override` (only preserved prefix steps are editable). `argsPatch` and `envPatch` continue to edit workflow args and environment for the replay.
- `rerunToolRequest({ jobId, argsPatch })` edits workflow args for a fresh run. `inputOverride` is not supported for rerun (it starts from index 0 with no snapshot) and returns `invalid_input_override`.
- `resumeToolRequest({ token, argsPatch })` edits workflow args before continuing a gated/paused run. `resumeToolRequest({ token, approved: true, approvedPayloadOverride })` performs edit-then-approve at an approval gate by replacing the approval step's `json` payload before continuing.

### Job chat sessions

A job can carry a reference to an external chat session (created by the OpenClaw plugin). Lobster core stores the host's session identity on the job and surfaces it in run envelopes so a frontend can deep-link to the job chat, and so the plugin can resolve and re-create the transcript from the job alone via `(agentId, sessionId, sessionKey)`.

- `setJobExternalSession({ jobId, sessionKey, provider, agentId, sessionId })` persists the mapping (`provider` defaults to `"openclaw"`). Pass `sessionKey: null` to clear it. `sessionKey` is the bare host session key (e.g. `lobster:<jobId>`); `agentId` is the OpenClaw agent id; `sessionId` is the host transcript's session id (the durable locator that lets the plugin write the chat transcript without depending on the host session store surviving).
- `getJob`/`listJobs` return `externalProvider`, `externalAgentId`, `externalSessionId`, and `externalSessionKey`.
- `run`/`resume`/`rewind` envelopes include `externalProvider` / `externalAgentId` / `externalSessionId` / `externalSessionKey` when the job has a bound session.
- `runToolRequest({ filePath, agent, model })` persists the job's `agent` and `model` identity on the job record (`getJob`/`listJobs` surface `agent`/`model`). `rerun`/`rewind` carry the source job's `agent`/`model` over to the new job (the per-job session is not carried; the caller decides whether to create one).
- `runToolRequest({ filePath, title, description, metadata })` persists optional job metadata for dashboard labeling. `metadata` must be a plain JSON object (not an array). `title` and `description` are trimmed strings. `rerun`/`rewind` carry the source job's metadata over to the new job, like `agent`/`model`.

#### In-workflow session/agent/model defaulting

When a job has a bound session/agent/model, in-workflow `openclaw.invoke` and `llm.invoke` (OpenClaw adapter) steps default to them so the call runs inside the job's chat session. Resolution precedence is **explicit step value > job's stored value > current default (no session)**. Core injects the job's values into the base step env (`LOBSTER_JOB_SESSION_KEY`, `LOBSTER_JOB_AGENT`, `LOBSTER_JOB_MODEL`) once per run, so per-step `--session-key`/`--agent`/`--model` (and an already-set ambient env value) still win. `llm.invoke` keeps `LOBSTER_LLM_MODEL` as the preferred LLM-specific default and falls back to `LOBSTER_JOB_MODEL` when no LLM-specific model is set. These are sent best-effort on the `/tools/invoke` body; gateways that do not yet honor them simply ignore the extra fields.

#### LLM routing: structured transport vs. in-process text hook

Lobster splits LLM work into two purpose-scoped paths so structured output is never lost to a text-only shim:

- **Structured `llm.invoke`** resolves a transport via `resolveProvider`/`resolveAdapter`: `--provider` → `LOBSTER_LLM_PROVIDER` → `config.defaultProvider` → env-URL transport → `openclaw`. This is the only path that returns structured `output.data` and honors `--output-schema`. The `openclaw` provider posts to the gateway `llm-task` transport (`/tools/invoke`); `pi`/`http` post to their adapter URLs. A host may inject a **structured** provider-keyed override via `ctx.llmAdapters[<provider>]`, which is used when that provider is selected explicitly (or by env). Resolution is explicit only — a registered adapter never becomes the implicit global default. The `AbortSignal` is threaded into the transport `fetch`, so gateway calls stay cancellable.
- **Internal text-only generation** (currently `metadata: auto`) prefers an optional in-process text hook, `ctx.llmText({ prompt, model?, signal? }) => { text }`. When present it runs in-process (no gateway round-trip, cancellable via the run's `AbortSignal`); when absent (standalone core) it falls back to the same transport resolution as `llm.invoke`. `ctx.llmText` is text-only by design and never intercepts structured `llm.invoke`.

The OpenClaw plugin provides `ctx.llmText` (wrapping the host's in-process `runtime.llm.complete`) for `metadata: auto`, and leaves structured `llm.invoke` on the gateway `llm-task` transport (using the inherited `OPENCLAW_URL`/`CLAWD_URL` env).

#### Per-step job metadata (`metadata: auto`)

A step's `metadata` can set the job `title`, `description`, and custom keys, either literally or with `"auto"` (LLM-generated from the step input/output via the in-process `ctx.llmText` hook, falling back to the transport when the hook is absent). Metadata is applied after the step's own `succeeded` checkpoint and always emits a terminal scoped `metadata` checkpoint (`name: "metadata"`): `succeeded` (carrying the resolved values, visible alongside `llm.invoke`/`pipeline-output` checkpoints) or `failed`. A failure is either a thrown error (`reason: "metadata_generation_failed"`) or requested `auto` output that came back empty (`reason: "metadata_generation_empty"` - no longer a silent no-op). Metadata generation follows the step's `on_error` policy, so a failure behaves like any step failure: with the default `on_error: stop` it halts the run at the scoped `${stepId}.metadata` checkpoint (replay/rewind-able); `on_error: continue` records the failed checkpoint and proceeds; `on_error: skip_rest` stops remaining steps while keeping prior output.

### Launching durable jobs from a command: `openclaw.lobster`

`openclaw.lobster` is `openclaw.invoke` with the tool pinned to `lobster`. It POSTs to the OpenClaw gateway `/tools/invoke` with `tool: "lobster"`, so the workflow runs through the plugin's `runToolRequest` path that creates a durable job (and, with `createSession`, a dedicated chat session) visible in the dashboard.

Use it when an OpenClaw-managed cron is a `command` job: a plain `lobster run …` executes the workflow locally and can hit approvals, but does not register a durable job, so it never appears in the frontend job list. Route the run through the tool instead:

```
openclaw.lobster run --args-json '{"filePath":"workflows/x.lobster","createSession":true,"stepMode":true}' --agent main --model anthropic/claude-sonnet-4-6
openclaw.lobster run --args-json '{"filePath":"workflows/x.lobster","title":"Weekly triage","description":"Review open PRs","metadata":{"source":"cron"}}'
openclaw.lobster run --args-json '{"filePath":"workflows/x.lobster","createSession":true}' --session-key user:chat:abc
openclaw.lobster listJobs --args-json '{"status":"waiting"}'
openclaw.lobster continue --args-json '{"jobId":"<id>"}'
```

The action is the required first positional argument; `--action` is not accepted by `openclaw.lobster`. Workflow/action params (`filePath`, `argsJson`, `jobId`, `stepMode`, `createSession`, `title`, `description`, `metadata`, `token`, `approvalId`, ...) travel inside `--args-json`. Job context params (`agent`, `model`, `sessionKey`, and `session-key`) are forbidden in `--args-json`; pass them as `--agent`, `--model`, and `--session-key` on `run` only. The OpenClaw lobster plugin must peel `title`, `description`, and `metadata` out of the run payload before forwarding remaining keys as workflow `args`. `LOBSTER_JOB_AGENT`, `LOBSTER_JOB_MODEL`, and `LOBSTER_JOB_SESSION_KEY` provide run-only env defaults. `createSession: true` creates a dedicated job chat; `--session-key` binds an existing chat and wins over `createSession`. Transport config matches `openclaw.invoke` (`--url`/`OPENCLAW_URL`, `--token`/`OPENCLAW_TOKEN`). Plain `lobster run` behavior is unchanged.

## Workflow files

Lobster workflow files are meant to read like small scripts:

- `run:` or `command:` for deterministic shell/CLI steps
- `pipeline:` for native Lobster stages like `llm.invoke`
- `approval:` for hard workflow gates between steps
- `stdin: $step.stdout` or `stdin: $step.json` to pass data forward

```
lobster run path/to/workflow.lobster
lobster run --file path/to/workflow.lobster --args-json '{"tag":"family"}'
```

Example file:

```yaml
name: jacket-advice
args:
  location:
    default: Phoenix
steps:
  - id: fetch
    run: weather --json ${location}

  - id: confirm
    approval: Want jacket advice from the LLM?
    stdin: $fetch.json

  - id: advice
    pipeline: >
      llm.invoke --prompt "Given this weather data, should I wear a jacket?
      Be concise and return JSON."
    stdin: $fetch.json
    when: $confirm.approved
```

Notes:

- `run:` and `command:` are equivalent; `run:` is the preferred spelling for new files.
- `pipeline:` shares the same args/env/results model as shell steps, so later steps can still reference `$step.stdout` or `$step.json`.
- If you need a human checkpoint before an LLM call, use a dedicated `approval:` step in the workflow file rather than `approve` inside the nested pipeline.
- `cwd`, `env`, `stdin`, `when`, and `condition` work for both shell and pipeline steps.
- Use `retry`, `timeout_ms`, and `on_error` per step to control transient-failure behavior and recovery.
- Approval steps can optionally enforce identity constraints:
  - `approval.required_approver` (or `requiredApprover`) requires an exact approver id.
  - `approval.require_different_approver` (or `requireDifferentApprover`) requires approver id to differ from initiator.
  - `approval.initiated_by` (or `initiatedBy`) sets the initiator id for comparison.
  - `LOBSTER_APPROVAL_INITIATED_BY` can provide a default initiator id at run time.
  - `LOBSTER_APPROVAL_APPROVED_BY` is used at resume/approval time for identity checks.

### Command-level input requests

Pipeline commands can call `ctx.requestInput({ prompt, responseSchema, defaults, subject, suspendedState })` to pause in tool mode, workflows, or the SDK and resume the same command after a structured response. CLI/tool resume tokens store only a state key; the persisted state validates the suspended request metadata before returning the submitted response to the command. SDK same-command resumes store the command frame in the configured SDK state directory.

Commands are re-run on resume, so they must be idempotent until `requestInput` returns. Array-backed command input is snapshotted with bounds for replay; lazy stream input is not buffered and requires a compact JSON `suspendedState` supplied by the command. On resume, call `ctx.requestInput.getSuspendedState()` before reading lazy input to restore that command-owned continuation state.

## Visualizing workflows

Use `lobster graph` to inspect workflow structure before execution.

```bash
lobster graph --file path/to/workflow.lobster
lobster graph --file path/to/workflow.lobster --format mermaid
lobster graph --file path/to/workflow.lobster --format dot
lobster graph --file path/to/workflow.lobster --format ascii
lobster graph --file path/to/workflow.lobster --args-json '{"location":"Seattle"}'
```

What gets visualized:

- each workflow step as a node (`run`, `pipeline`, `approval`, etc.)
- data-flow edges from `stdin: $step.stdout` / `$step.json` references
- conditional dependencies from `when:` / `condition:` expressions
- approval gates as diamond-shaped nodes in `mermaid` and `dot` output

Format notes:

- `mermaid` (default): emits `flowchart TD` text for GitHub/Markdown rendering
- `dot`: emits Graphviz DOT syntax
- `ascii`: emits a terminal-friendly node/edge list

## Calling LLMs from workflows

Use `llm.invoke` from a native `pipeline:` step for model-backed work:

```bash
llm.invoke --prompt 'Summarize this diff'
llm.invoke --provider openclaw --prompt 'Summarize this diff'
llm.invoke --provider pi --prompt 'Summarize this diff'
```

Provider resolution order (explicit only — a registered `ctx.llmAdapters` entry never becomes the implicit default):

- `--provider`
- `LOBSTER_LLM_PROVIDER`
- the pipeline's `config.defaultProvider`
- env-URL transport (`LOBSTER_PI_LLM_ADAPTER_URL` → `pi`, `OPENCLAW_URL`/`CLAWD_URL` → `openclaw`, `LOBSTER_LLM_ADAPTER_URL` → `http`)
- `openclaw` (default)

Built-in providers today:

- `openclaw` via `OPENCLAW_URL` / `OPENCLAW_TOKEN`
- `pi` via `LOBSTER_PI_LLM_ADAPTER_URL` (typically supplied by the Pi extension)
- `http` via `LOBSTER_LLM_ADAPTER_URL`

Model resolution is `--model`, then `LOBSTER_LLM_MODEL`, then `LOBSTER_JOB_MODEL`, then provider defaults. `LOBSTER_LLM_MODEL` remains the LLM-specific override; `LOBSTER_JOB_MODEL` is the inherited durable-job model default.

Workflow `_meta.cost` and `cost_limit` use a static pricing table plus optional overrides from `LOBSTER_LLM_PRICING_JSON`, for example `{"my-model":{"input":1.0,"output":2.0}}` in USD per million tokens. Unknown or missing model IDs still record token counts with zero estimated cost, but Lobster warns on stderr so stale or missing pricing does not fail silently.

`llm_task.invoke` remains available as a backward-compatible alias for the OpenClaw provider.

### `pipeline:` vs `run:` for LLM calls

- Use `pipeline:` for `llm.invoke` and `llm_task.invoke` (they are Lobster pipeline stages, not shell executables).
- Use `run:` only for real binaries in your shell (for example `openclaw.invoke`).

Example (`stdin` from a prior step is passed to the LLM as artifacts):

```yaml
steps:
  - id: make_words
    run: echo "One two three four five six"

  - id: count_words
    pipeline: llm_task.invoke --prompt "How many words have been pasted below?"
    stdin: $make_words.stdout
```

## Calling OpenClaw tools from workflows

Shell `run:` steps execute in your system shell, so OpenClaw tool calls there must be real executables.

If you install Lobster via npm/pnpm, it installs a small shim executable named:

- `openclaw.invoke` (preferred)
- `clawd.invoke` (alias)

These shims forward to the Lobster pipeline command of the same name.

### Example: invoke llm-task

Prereqs:

- optionally `OPENCLAW_URL` points at a running OpenClaw gateway
- optionally `OPENCLAW_TOKEN` if auth is enabled

```bash
export OPENCLAW_URL=http://127.0.0.1:18789
export OPENCLAW_TOKEN=...
```

In a workflow:

```yaml
name: hello-world
steps:
  - id: greeting
    run: >
      openclaw.invoke --tool llm-task --action json --args-json '{"prompt":"Hello"}'
```

### Passing data between steps (no temp files)

Use `stdin: $stepId.stdout` to pipe output from one step into the next.

## Args and shell-safety

`${arg}` substitution is a raw string replace into the shell command text.

For anything that may contain quotes, `$`, backticks, or newlines, prefer env vars:

- every resolved workflow arg is exposed as `LOBSTER_ARG_<NAME>` (uppercased, non-alnum → `_`)
- the full args object is also available as `LOBSTER_ARGS_JSON`

Example:

```yaml
args:
  text:
    default: ""
steps:
  - id: safe
    env:
      TEXT: "$LOBSTER_ARG_TEXT"
    command: |
      jq -n --arg text "$TEXT" '{"result": $text}'
```
