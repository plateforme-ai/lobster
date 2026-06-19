import { DEFAULT_OPENCLAW_URL } from "../providers.js";

export type InvokeCommandOptions = {
  /** When set, the tool name is pinned to this value and `--tool` is ignored. */
  fixedTool?: string;
  /** When set, the action must be the first positional argument instead of --action. */
  positionalActionOnly?: boolean;
  /** When set, agent/model/session context is only valid for the run action. */
  runScopedContext?: boolean;
  /** When set, agent/model/session context keys are rejected inside --args-json. */
  forbidContextInArgsJson?: boolean;
  /** When set, the action is validated against this list. */
  knownActions?: readonly string[];
  /** Override the command description. */
  description?: string;
  /** Override the help text. */
  help?: () => string;
};

export function createInvokeCommand(commandName: string, options: InvokeCommandOptions = {}) {
  const {
    fixedTool,
    knownActions,
    positionalActionOnly,
    runScopedContext,
    forbidContextInArgsJson,
  } = options;
  const toolProperty = fixedTool
    ? {}
    : { tool: { type: "string", description: "Tool name (e.g. message, cron, github, etc.)" } };
  const actionProperty = positionalActionOnly
    ? {}
    : { action: { type: "string", description: "Tool action" } };
  return {
    name: commandName,
    meta: {
      description: options.description ?? "Call a local OpenClaw tool endpoint",
      argsSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "OpenClaw control URL (or OPENCLAW_URL / CLAWD_URL)",
            default: DEFAULT_OPENCLAW_URL,
          },
          token: { type: "string", description: "Bearer token (or OPENCLAW_TOKEN / CLAWD_TOKEN)" },
          ...toolProperty,
          ...actionProperty,
          "args-json": { type: "string", description: "JSON string of tool args" },
          sessionKey: { type: "string", description: "Optional session key attribution" },
          "session-key": { type: "string", description: "Alias for sessionKey" },
          agent: { type: "string", description: "Optional agent attribution or job identity" },
          model: { type: "string", description: "Optional model attribution or job identity" },
          dryRun: { type: "boolean", description: "Dry run" },
          "dry-run": { type: "boolean", description: "Alias for dryRun" },
          each: { type: "boolean", description: "Map each pipeline item into tool args" },
          itemKey: {
            type: "string",
            description: "Key to set from the pipeline item (default: item)",
          },
          "item-key": { type: "string", description: "Alias for itemKey" },
          _: { type: "array", items: { type: "string" } },
        },
        required: positionalActionOnly ? ["_"] : fixedTool ? ["action"] : ["tool", "action"],
      },
      sideEffects: ["calls_clawd_tool"],
    },
    help:
      options.help ??
      function () {
        return (
          `${commandName} — call a local OpenClaw tool endpoint\n\n` +
          `Usage:\n` +
          `  ${commandName} --tool message --action send --args-json '{"provider":"telegram","to":"...","message":"..."}'\n` +
          `  ${commandName} --tool message --action send --args-json '{...}' --dry-run\n` +
          `  ... | ${commandName} --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'\n\n` +
          `Config:\n` +
          `  - Uses OPENCLAW_URL env var or ${DEFAULT_OPENCLAW_URL} by default (or pass --url).\n` +
          `  - Backward compatible: CLAWD_URL is also supported.\n` +
          `  - Optional Bearer token via OPENCLAW_TOKEN env var (or pass --token).\n` +
          `  - Backward compatible: CLAWD_TOKEN is also supported.\n` +
          `  - Optional attribution via --session-key <sessionKey>.\n\n` +
          `Notes:\n` +
          `  - This is a thin transport bridge. Lobster should not own OAuth/secrets.\n`
        );
      },
    async run({ input, args, ctx }) {
      const each = Boolean(args.each);
      const itemKey = String(args.itemKey ?? args["item-key"] ?? "item");

      const url = String(
        args.url ?? ctx.env.OPENCLAW_URL ?? ctx.env.CLAWD_URL ?? DEFAULT_OPENCLAW_URL,
      ).trim();
      const tool = fixedTool ?? args.tool;
      const positional = Array.isArray(args._) ? args._ : [];
      if (positionalActionOnly && args.action !== undefined) {
        throw new Error(
          `${commandName} expects action as the first positional argument, not --action`,
        );
      }
      if (positionalActionOnly && positional.length === 0) {
        throw new Error(`${commandName} requires action as the first positional argument`);
      }
      if (positionalActionOnly && positional.length > 1) {
        throw new Error(`${commandName} accepts exactly one positional action`);
      }
      const action = positionalActionOnly ? positional[0] : args.action;
      if (!tool || !action) {
        throw new Error(
          fixedTool
            ? `${commandName} requires --action`
            : `${commandName} requires --tool and --action`,
        );
      }
      if (knownActions && !knownActions.includes(String(action))) {
        throw new Error(`${commandName} action must be one of ${knownActions.join(", ")}`);
      }

      const token = String(
        args.token ?? ctx.env.OPENCLAW_TOKEN ?? ctx.env.CLAWD_TOKEN ?? "",
      ).trim();

      let toolArgs: any = {};
      if (args["args-json"]) {
        try {
          toolArgs = JSON.parse(String(args["args-json"]));
        } catch (_err) {
          throw new Error(`${commandName} --args-json must be valid JSON`);
        }
      }

      if (each && (toolArgs === null || typeof toolArgs !== "object" || Array.isArray(toolArgs))) {
        throw new Error(`${commandName} --each requires --args-json to be an object`);
      }
      if (
        forbidContextInArgsJson &&
        toolArgs &&
        typeof toolArgs === "object" &&
        !Array.isArray(toolArgs)
      ) {
        for (const key of ["agent", "model", "sessionKey", "session-key"]) {
          if (key in toolArgs) {
            throw new Error(
              `${commandName} ${key} must be passed as a CLI flag, not inside --args-json`,
            );
          }
        }
      }

      const endpoint = new URL("/tools/invoke", url);
      const actionName = String(action);
      const contextAllowed = !runScopedContext || actionName === "run";
      const explicitSessionKey = args.sessionKey ?? args["session-key"] ?? null;
      const explicitAgent = args.agent ?? null;
      const explicitModel = args.model ?? null;
      if (
        !contextAllowed &&
        (explicitSessionKey !== null || explicitAgent !== null || explicitModel !== null)
      ) {
        throw new Error(
          `${commandName} --agent, --model, and --session-key are only valid for run`,
        );
      }
      const sessionKey = contextAllowed
        ? (explicitSessionKey ?? ctx.env.LOBSTER_JOB_SESSION_KEY ?? null)
        : null;
      const agent = contextAllowed ? (explicitAgent ?? ctx.env.LOBSTER_JOB_AGENT ?? null) : null;
      const model = contextAllowed ? (explicitModel ?? ctx.env.LOBSTER_JOB_MODEL ?? null) : null;
      const dryRun = args.dryRun ?? args["dry-run"] ?? null;

      const invokeOnce = async (argsValue: unknown) => {
        const forwardedArgs =
          runScopedContext &&
          actionName === "run" &&
          argsValue &&
          typeof argsValue === "object" &&
          !Array.isArray(argsValue)
            ? {
                ...(argsValue as Record<string, unknown>),
                ...(sessionKey ? { sessionKey: String(sessionKey) } : null),
                ...(agent ? { agent: String(agent) } : null),
                ...(model ? { model: String(model) } : null),
              }
            : argsValue;
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : null),
            ...(ctx.checkpointRun?.runId
              ? { "x-lobster-run-id": String(ctx.checkpointRun.runId) }
              : null),
            ...(ctx.checkpointRun?.latestCheckpointId
              ? { "x-lobster-checkpoint-id": String(ctx.checkpointRun.latestCheckpointId) }
              : null),
          },
          body: JSON.stringify({
            tool: String(tool),
            action: actionName,
            args: forwardedArgs,
            ...(sessionKey ? { sessionKey: String(sessionKey) } : null),
            ...(agent ? { agent: String(agent) } : null),
            ...(model ? { model: String(model) } : null),
            ...(dryRun !== null ? { dryRun: Boolean(dryRun) } : null),
          }),
        });

        const text = await res.text();
        if (!res.ok) {
          throw new Error(`${commandName} failed (${res.status}): ${text.slice(0, 400)}`);
        }

        let parsed: any;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch (_err) {
          throw new Error(`${commandName} expected JSON response`);
        }

        // Preferred: { ok: true, result: ... }
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "ok" in parsed) {
          if (parsed.ok !== true) {
            const msg = parsed?.error?.message ?? "Unknown error";
            throw new Error(`${commandName} tool error: ${msg}`);
          }
          const result = parsed.result;
          return Array.isArray(result) ? result : [result];
        }

        // Compatibility: raw JSON result
        return Array.isArray(parsed) ? parsed : [parsed];
      };

      if (!each) {
        // Drain input: for now we don't stream input into clawd calls.
        for await (const _item of input) {
          // no-op
        }
        const items = await invokeOnce(toolArgs);
        return { output: asStream(items) };
      }

      const out: any[] = [];
      for await (const item of input) {
        const argsValue = { ...(toolArgs as any), [itemKey]: item };
        const items = await invokeOnce(argsValue);
        out.push(...items);
      }

      return { output: asStream(out) };
    },
  };
}

async function* asStream(items: any[]) {
  for (const item of items) yield item;
}

export const openclawInvokeCommand = createInvokeCommand("openclaw.invoke");
export const clawdInvokeCommand = createInvokeCommand("clawd.invoke");
