import { DEFAULT_OPENCLAW_URL } from "../providers.js";
import { createInvokeCommand } from "./openclaw_invoke.js";

const LOBSTER_ACTIONS = [
  "run",
  "resume",
  "continue",
  "pause",
  "cancel",
  "setStepMode",
  "getJob",
  "getRun",
  "listJobs",
  "listJobRuns",
  "listPendingApprovals",
  "listJobCheckpoints",
  "listRunCheckpoints",
  "getCheckpoint",
  "getCheckpointIO",
  "rerun",
  "rewind",
] as const;

const commandName = "openclaw.lobster";

function lobsterHelp() {
  return (
    `${commandName} — run/manage Lobster durable workflows via the OpenClaw lobster tool\n\n` +
    `This is openclaw.invoke with the tool pinned to "lobster". Unlike a plain\n` +
    `\`lobster run\`, going through the OpenClaw tool creates a durable job (and an\n` +
    `optional dedicated chat session) that shows up in the dashboard.\n\n` +
    `Usage:\n` +
    `  ${commandName} run --args-json '{"filePath":"workflows/x.lobster","createSession":true,"stepMode":true}' --agent main --model anthropic/claude-sonnet-4-6\n` +
    `  ${commandName} run --args-json '{"filePath":"workflows/x.lobster","createSession":true}' --session-key user:chat:abc\n` +
    `  ${commandName} listJobs --args-json '{"status":"waiting"}'\n` +
    `  ${commandName} continue --args-json '{"jobId":"<id>"}'\n` +
    `  ${commandName} resume --args-json '{"jobId":"<id>","approve":true}'\n\n` +
    `Config:\n` +
    `  - Uses OPENCLAW_URL env var or ${DEFAULT_OPENCLAW_URL} by default (or pass --url).\n` +
    `  - Backward compatible: CLAWD_URL is also supported.\n` +
    `  - Optional Bearer token via OPENCLAW_TOKEN env var (or pass --token).\n` +
    `  - On run only: optional job identity via --agent, --model, --session-key.\n` +
    `  - Env defaults for run: LOBSTER_JOB_AGENT, LOBSTER_JOB_MODEL, LOBSTER_JOB_SESSION_KEY.\n\n` +
    `Actions: ${LOBSTER_ACTIONS.join(", ")}\n\n` +
    `Notes:\n` +
    `  - The action is the required first positional arg; --action is not accepted.\n` +
    `  - Workflow/action params (filePath, argsJson, jobId, stepMode,\n` +
    `    createSession, token, approvalId, ...) go inside --args-json.\n` +
    `  - agent, model, sessionKey, and session-key are not accepted in --args-json.\n` +
    `  - createSession creates a dedicated job chat; --session-key binds an existing chat.\n` +
    `  - This is a thin transport bridge. Lobster should not own OAuth/secrets.\n`
  );
}

export const openclawLobsterCommand = createInvokeCommand(commandName, {
  fixedTool: "lobster",
  positionalActionOnly: true,
  runScopedContext: true,
  forbidContextInArgsJson: true,
  knownActions: LOBSTER_ACTIONS,
  description: "Run and manage Lobster durable workflows via the OpenClaw lobster tool",
  help: lobsterHelp,
});
