import { createHash } from "node:crypto";
import { Ajv } from "ajv";
import type { ErrorObject } from "ajv";

import {
  isJsonSyntaxError,
  readStateJson,
  stableStringify,
  writeStateJson,
} from "../../store/state.js";
import {
  readCacheEntry as readSqliteCacheEntry,
  writeCacheEntry as writeSqliteCacheEntry,
} from "../../store/runtime_store.js";
import type { SupportedProvider } from "../providers.js";
import { createCompileCached } from "../../validation.js";
import type { LobsterCommand } from "../types.js";
import {
  getFirstEnv,
  resolveAdapter,
  resolveEnvString,
  resolveModel,
  resolveProvider,
} from "./llm_client.js";
import type { LlmResponseEnvelope } from "./llm_client.js";

const ajv = new Ajv({ allErrors: true, strict: false });
const compileCachedLocal = createCompileCached(ajv);

const artifactSchema = {
  type: "object",
  properties: {
    kind: { type: "string" },
    role: { type: "string" },
    name: { type: "string" },
    mimeType: { type: "string" },
    text: { type: "string" },
    data: {},
    uri: { type: "string" },
  },
  additionalProperties: true,
};

const payloadSchema = {
  type: "object",
  properties: {
    prompt: { type: "string", minLength: 1 },
    model: { type: "string", minLength: 1 },
    artifacts: { type: "array", items: artifactSchema },
    artifactHashes: { type: "array", items: { type: "string", minLength: 10 } },
    schemaVersion: { type: "string" },
    metadata: { type: "object", additionalProperties: true },
    outputSchema: { type: "object", additionalProperties: true },
    temperature: { type: "number" },
    maxOutputTokens: { type: "number" },
    retryContext: {
      type: "object",
      properties: {
        attempt: { type: "number" },
        validationErrors: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  required: ["prompt", "artifacts", "artifactHashes"],
  additionalProperties: false,
};

const responseSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    result: {
      type: "object",
      properties: {
        runId: { type: "string" },
        model: { type: "string" },
        prompt: { type: "string" },
        status: { type: "string" },
        output: {
          type: "object",
          properties: {
            text: { type: "string" },
            data: {},
            format: { type: "string" },
          },
          required: [],
          additionalProperties: true,
        },
        usage: {
          type: "object",
          properties: {
            inputTokens: { type: "number" },
            outputTokens: { type: "number" },
            totalTokens: { type: "number" },
          },
          additionalProperties: true,
        },
        warnings: { type: "array", items: { type: "string" } },
        metadata: { type: "object", additionalProperties: true },
        diagnostics: { type: "object", additionalProperties: true },
      },
      required: ["output"],
      additionalProperties: true,
    },
    error: { type: "object", additionalProperties: true },
  },
  required: ["ok"],
  additionalProperties: true,
};

const validatePayload = ajv.compile(payloadSchema);
const validateResponseEnvelope = ajv.compile(responseSchema);

const STATE_VERSION = 1;
const DEFAULT_MAX_VALIDATION_RETRIES = 1;

type NormalizedInvocationItem = {
  kind: string;
  runId: string | null;
  prompt: string | null;
  model: string | null;
  schemaVersion: string | null;
  status: string;
  cacheKey: string;
  artifactHashes: string[];
  output: { format: string | null; text: string | null; data: any };
  usage: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  warnings: string[] | null;
  diagnostics: Record<string, unknown> | null;
  createdAt: string;
  source: string;
  cached: boolean;
  attemptCount: number;
};

type CacheEntry = {
  items: NormalizedInvocationItem[];
  cacheKey: string;
  storedAt: string;
};

type CommandConfig = {
  name: string;
  itemKind: string;
  stateType: string;
  cacheNamespace: string;
  defaultProvider?: SupportedProvider | null;
  description: string;
  helpTitle: string;
  helpConfig: string[];
  helpExamples: string[];
  sourceForProvider?: (provider: SupportedProvider) => string;
  legacyEnvCompat?: boolean;
};

export const llmInvokeCommand = createLlmInvokeCommand({
  name: "llm.invoke",
  itemKind: "llm.invoke",
  stateType: "llm.invoke",
  cacheNamespace: "llm.invoke",
  defaultProvider: null,
  description: "Call a configured LLM adapter with typed payloads and caching",
  helpTitle: "llm.invoke — call a configured LLM adapter with caching and schema validation",
  helpConfig: [
    "Provider resolution order: --provider, LOBSTER_LLM_PROVIDER, then environment auto-detect.",
    "Built-in providers: openclaw, pi, http.",
    "OpenClaw provider uses OPENCLAW_URL (CLAWD_URL also supported) and OPENCLAW_TOKEN.",
    "Pi provider uses LOBSTER_PI_LLM_ADAPTER_URL and is intended to be supplied by a Pi extension.",
    "Generic http provider uses LOBSTER_LLM_ADAPTER_URL and optional LOBSTER_LLM_ADAPTER_TOKEN.",
  ],
  helpExamples: [
    "llm.invoke --prompt 'Write summary'",
    "llm.invoke --provider openclaw --model claude-3-sonnet --prompt 'Write summary'",
    "cat artifacts.json | llm.invoke --provider pi --prompt 'Score each item'",
    "... | llm.invoke --prompt 'Plan next steps' --output-schema '{\"type\":\"object\"}'",
  ],
  sourceForProvider(provider) {
    return provider;
  },
  legacyEnvCompat: true,
});

export const llmTaskInvokeCommand = createLlmInvokeCommand({
  name: "llm_task.invoke",
  itemKind: "llm_task.invoke",
  stateType: "llm_task.invoke",
  cacheNamespace: "llm_task.invoke",
  defaultProvider: "openclaw",
  description: "Backward-compatible alias for llm.invoke using the OpenClaw adapter",
  helpTitle: "llm_task.invoke — backward-compatible alias for llm.invoke using OpenClaw",
  helpConfig: [
    "Requires OPENCLAW_URL (or CLAWD_URL) and optionally OPENCLAW_TOKEN.",
    "Use llm.invoke for new workflows and non-OpenClaw adapters.",
  ],
  helpExamples: [
    "llm_task.invoke --prompt 'Write summary'",
    "llm_task.invoke --model claude-3-sonnet --prompt 'Write summary'",
    "cat artifacts.json | llm_task.invoke --prompt 'Score each item'",
  ],
  sourceForProvider() {
    return "clawd";
  },
  legacyEnvCompat: true,
});

export function createLlmInvokeCommand(config: CommandConfig): LobsterCommand {
  return {
    name: config.name,
    meta: {
      description: config.description,
      argsSchema: {
        type: "object",
        properties: {
          provider: {
            type: "string",
            description: "LLM adapter provider (openclaw, pi, http). Optional if auto-detected.",
          },
          token: {
            type: "string",
            description: "Optional bearer token for providers that support it.",
          },
          prompt: { type: "string", description: "Primary prompt / instructions" },
          model: {
            type: "string",
            description: "Model identifier. Optional; adapter defaults may apply if omitted.",
          },
          "artifacts-json": { type: "string", description: "JSON array of artifacts to send" },
          "metadata-json": { type: "string", description: "JSON object of metadata to include" },
          "output-schema": { type: "string", description: "JSON schema LLM output must satisfy" },
          "schema-version": { type: "string", description: "Logical schema version for caching" },
          "max-validation-retries": {
            type: "number",
            description: "Retries when schema validation fails",
          },
          temperature: { type: "number", description: "Sampling temperature" },
          "max-output-tokens": { type: "number", description: "Max completion tokens" },
          "state-key": {
            type: "string",
            description: "Run-state key override (else LOBSTER_RUN_STATE_KEY)",
          },
          refresh: { type: "boolean", description: "Bypass run-state + cache" },
          "disable-cache": { type: "boolean", description: "Skip persistent cache" },
          _: { type: "array", items: { type: "string" } },
        },
        required: [],
      },
      sideEffects: ["calls_llm"],
    },
    help() {
      const lines = [
        config.helpTitle,
        "",
        "Usage:",
        ...config.helpExamples.map((example) => `  ${example}`),
        "",
        "Features:",
        "  - Typed payload validation before invoking the adapter.",
        "  - Run-state + file cache so resumes do not re-call the LLM.",
        "  - Optional JSON-schema enforcement with bounded retries.",
        "",
        "Config:",
        ...config.helpConfig.map((line) => `  - ${line}`),
      ];
      return `${lines.join("\n")}\n`;
    },
    async run({ input, args, ctx }) {
      return runLlmInvoke({ input, args, ctx, config });
    },
  } satisfies LobsterCommand;
}

async function runLlmInvoke({
  input,
  args,
  ctx,
  config,
}: {
  input: AsyncIterable<any>;
  args: any;
  ctx: any;
  config: CommandConfig;
}) {
  const env = ctx.env ?? process.env;
  const provider = resolveProvider(args, env, config.defaultProvider, ctx);
  const adapter = resolveAdapter({ provider, env, args, config, ctx });
  const prompt = extractPrompt(args);
  if (!prompt) throw new Error(`${config.name} requires --prompt or positional text`);

  const model = resolveModel(args, env, config.legacyEnvCompat);
  const schemaVersion = resolveEnvString(
    args["schema-version"],
    ["LOBSTER_LLM_SCHEMA_VERSION", ...(config.legacyEnvCompat ? ["LLM_TASK_SCHEMA_VERSION"] : [])],
    env,
    "v1",
  );
  const maxOutputTokens = parseOptionalNumber(args["max-output-tokens"]);
  const temperature = parseOptionalNumber(args.temperature);
  const providedArtifacts = parseJsonArray(
    args["artifacts-json"],
    `${config.name} --artifacts-json`,
  );
  const metadataObject = parseJsonObject(args["metadata-json"], `${config.name} --metadata-json`);
  const userOutputSchema = parseJsonObject(args["output-schema"], `${config.name} --output-schema`);
  const maxValidationRetriesRaw =
    args["max-validation-retries"] ??
    getFirstEnv(env, [
      "LOBSTER_LLM_VALIDATION_RETRIES",
      ...(config.legacyEnvCompat ? ["LLM_TASK_VALIDATION_RETRIES"] : []),
    ]);
  const maxValidationRetries = userOutputSchema
    ? Math.max(
        0,
        Number.isFinite(Number(maxValidationRetriesRaw))
          ? Number(maxValidationRetriesRaw)
          : DEFAULT_MAX_VALIDATION_RETRIES,
      )
    : 0;
  const disableCache = flag(args["disable-cache"]);
  const forceRefresh = flag(
    args.refresh ??
      getFirstEnv(env, [
        "LOBSTER_LLM_FORCE_REFRESH",
        ...(config.legacyEnvCompat ? ["LLM_TASK_FORCE_REFRESH"] : []),
      ]),
  );
  const stateKey = String(args["state-key"] ?? env.LOBSTER_RUN_STATE_KEY ?? "").trim() || null;

  const inputArtifacts: any[] = [];
  for await (const item of input) inputArtifacts.push(item);

  const normalizedArtifacts = [...inputArtifacts, ...providedArtifacts].map(normalizeArtifact);
  const artifactHashes = normalizedArtifacts.map(hashArtifact);
  const cacheKey = computeCacheKey({
    provider,
    prompt,
    model,
    schemaVersion,
    artifactHashes,
    outputSchema: userOutputSchema,
  });

  if (stateKey && !forceRefresh) {
    const stored = await readReusableLlmState(env, stateKey);
    const reused = pickReusableState(stored, cacheKey, config.stateType);
    if (reused) {
      return {
        output: streamOf(
          reused.items.map((item) => ({ ...item, source: "run_state", cached: true })),
        ),
      };
    }
  }

  if (!disableCache && !forceRefresh) {
    const cache = await readCacheEntry(env, cacheKey, config.cacheNamespace);
    if (cache) {
      return {
        output: streamOf(cache.items.map((item) => ({ ...item, source: "cache", cached: true }))),
      };
    }
  }

  const payload: Record<string, any> = {
    prompt,
    ...(model ? { model } : null),
    artifacts: normalizedArtifacts,
    artifactHashes,
  };
  if (metadataObject) payload.metadata = metadataObject;
  if (userOutputSchema) payload.outputSchema = userOutputSchema;
  if (schemaVersion) payload.schemaVersion = schemaVersion;
  if (Number.isFinite(maxOutputTokens ?? NaN)) payload.maxOutputTokens = Number(maxOutputTokens);
  if (Number.isFinite(temperature ?? NaN)) payload.temperature = Number(temperature);

  if (!validatePayload(payload)) {
    throw new Error(`${config.name} payload invalid: ${ajv.errorsText(validatePayload.errors)}`);
  }

  const validator = userOutputSchema ? compileCachedLocal(userOutputSchema) : null;
  let attempt = 0;
  let lastValidationErrors: string[] = [];

  while (true) {
    attempt += 1;
    if (attempt > 1) {
      payload.retryContext = {
        attempt,
        ...(lastValidationErrors.length ? { validationErrors: lastValidationErrors } : null),
      };
    } else {
      delete payload.retryContext;
    }

    let responseEnvelope: LlmResponseEnvelope;
    try {
      responseEnvelope = await adapter.invoke({ env, args, payload });
    } catch (err: any) {
      throw new Error(`${config.name} request failed: ${err?.message ?? String(err)}`);
    }

    if (!validateResponseEnvelope(responseEnvelope)) {
      throw new Error(
        `${config.name} received invalid response envelope: ${JSON.stringify(responseEnvelope)}`,
      );
    }

    if (responseEnvelope.ok !== true) {
      const message = responseEnvelope.error?.message ?? "llm adapter returned an error";
      throw new Error(`${config.name} remote error: ${message}`);
    }

    const normalized = normalizeResult({
      envelope: responseEnvelope,
      cacheKey,
      schemaVersion,
      artifactHashes,
      source: adapter.source,
      attempt,
      itemKind: config.itemKind,
    });

    if (!validator) {
      await persistOutputs({
        env,
        stateKey,
        cacheKey,
        items: normalized,
        stateType: config.stateType,
      });
      if (!disableCache) {
        await writeCacheEntry(env, cacheKey, normalized, config.cacheNamespace, {
          input: payload,
          provider,
          model,
          status: normalized[0]?.status,
        });
      }
      return { output: streamOf(normalized) };
    }

    const structured = normalized[0]?.output?.data ?? null;
    if (validator(structured)) {
      await persistOutputs({
        env,
        stateKey,
        cacheKey,
        items: normalized,
        stateType: config.stateType,
      });
      if (!disableCache) {
        await writeCacheEntry(env, cacheKey, normalized, config.cacheNamespace, {
          input: payload,
          provider,
          model,
          status: normalized[0]?.status,
        });
      }
      return { output: streamOf(normalized) };
    }

    lastValidationErrors = collectAjvErrors(validator.errors);
    if (attempt > maxValidationRetries + 1) {
      throw new Error(
        `${config.name} output failed schema validation: ${lastValidationErrors.join("; ")}`,
      );
    }
  }
}

function extractPrompt(args: any) {
  if (args.prompt) return String(args.prompt);
  if (Array.isArray(args._) && args._.length) {
    return args._.join(" ");
  }
  return "";
}

function parseJsonArray(raw: any, label: string) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) throw new Error("must be array");
    return parsed;
  } catch {
    throw new Error(`${label} must be a JSON array`);
  }
}

function parseJsonObject(raw: any, label: string) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("must be an object");
    }
    return parsed;
  } catch {
    throw new Error(`${label} must be a JSON object`);
  }
}

function parseOptionalNumber(value: any) {
  if (value === undefined || value === null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function flag(value: any) {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["false", "0", "no"].includes(normalized)) return false;
    if (["true", "1", "yes"].includes(normalized)) return true;
  }
  return Boolean(value);
}

function normalizeArtifact(raw: any) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    return { kind: "text", text: raw };
  }
  if (typeof raw === "number" || typeof raw === "boolean") {
    return { kind: "text", text: String(raw) };
  }
  return { kind: "json", data: raw };
}

function hashArtifact(artifact: any) {
  const stable = stableStringify(artifact);
  return createHash("sha256").update(stable).digest("hex");
}

function computeCacheKey({
  provider,
  prompt,
  model,
  schemaVersion,
  artifactHashes,
  outputSchema,
}: {
  provider: SupportedProvider;
  prompt: string;
  model: string;
  schemaVersion: string;
  artifactHashes: string[];
  outputSchema: any;
}) {
  const payload = {
    provider,
    prompt,
    model: model || `${provider}-default`,
    schemaVersion,
    artifactHashes,
    outputSchema: outputSchema ?? null,
  };
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function normalizeResult({
  envelope,
  cacheKey,
  schemaVersion,
  artifactHashes,
  source,
  attempt,
  itemKind,
}: {
  envelope: LlmResponseEnvelope;
  cacheKey: string;
  schemaVersion: string;
  artifactHashes: string[];
  source: string;
  attempt: number;
  itemKind: string;
}): NormalizedInvocationItem[] {
  const result = envelope.result ?? {};
  const output = result.output ?? {};
  const item: NormalizedInvocationItem = {
    kind: itemKind,
    runId: (result.runId ?? null) as any,
    prompt: (result.prompt ?? null) as any,
    model: (result.model ?? null) as any,
    schemaVersion,
    status: String(result.status ?? "completed"),
    cacheKey,
    artifactHashes,
    output: {
      format: (output.format ?? (output.data ? "json" : "text")) as any,
      text: (output.text ?? null) as any,
      data: (output.data ?? null) as any,
    },
    usage: (result.usage ?? null) as any,
    metadata: (result.metadata ?? null) as any,
    warnings: (result.warnings ?? null) as any,
    diagnostics: (result.diagnostics ?? null) as any,
    createdAt: new Date().toISOString(),
    source,
    cached:
      source !== "remote" &&
      source !== "openclaw" &&
      source !== "clawd" &&
      source !== "pi" &&
      source !== "http",
    attemptCount: attempt,
  };
  return [item];
}

async function persistOutputs({
  env,
  stateKey,
  cacheKey,
  items,
  stateType,
}: {
  env: any;
  stateKey: string | null;
  cacheKey: string;
  items: NormalizedInvocationItem[];
  stateType: string;
}) {
  if (!stateKey) return;
  const record = {
    type: stateType,
    version: STATE_VERSION,
    cacheKey,
    items,
    storedAt: new Date().toISOString(),
  };
  await writeStateJson({ env, key: stateKey, value: record });
}

async function readReusableLlmState(env: any, stateKey: string) {
  try {
    return await readStateJson({ env, key: stateKey });
  } catch (err: any) {
    if (isJsonSyntaxError(err)) return null;
    throw err;
  }
}

function pickReusableState(stored: any, cacheKey: string, stateType: string) {
  if (!stored || typeof stored !== "object") return null;
  if (stored.type !== stateType) return null;
  if (stored.cacheKey !== cacheKey) return null;
  if (!Array.isArray(stored.items)) return null;
  return { items: stored.items as NormalizedInvocationItem[] };
}

function collectAjvErrors(errors: ErrorObject[] | null | undefined) {
  if (!errors?.length) return [];
  return errors.map((err) => `${err.instancePath || "/"} ${err.message ?? ""}`.trim());
}

async function readCacheEntry(
  env: any,
  key: string,
  cacheNamespace: string,
): Promise<CacheEntry | null> {
  const entry = await readSqliteCacheEntry({ env, namespace: cacheNamespace, cacheKey: key });
  if (!entry) return null;
  return {
    cacheKey: entry.cacheKey,
    items: entry.items as NormalizedInvocationItem[],
    storedAt: entry.updatedAt,
  };
}

async function writeCacheEntry(
  env: any,
  key: string,
  items: NormalizedInvocationItem[],
  cacheNamespace: string,
  metadata: {
    input?: unknown;
    provider?: string | null;
    model?: string | null;
    status?: string | null;
  } = {},
) {
  await writeSqliteCacheEntry({
    env,
    entry: {
      namespace: cacheNamespace,
      cacheKey: key,
      items,
      input: metadata.input,
      provider: metadata.provider,
      model: metadata.model,
      status: metadata.status,
    },
  });
}

async function* streamOf(items: any[]) {
  for (const item of items) yield item;
}
