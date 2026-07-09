import { DEFAULT_OPENCLAW_URL } from "../providers.js";
import type { SupportedProvider } from "../providers.js";

export type LlmResponse = {
  runId?: string | null;
  model?: string | null;
  prompt?: string | null;
  status?: string | null;
  output?: {
    text?: string | null;
    data?: any;
    format?: string | null;
  } | null;
  usage?: Record<string, unknown> | null;
  warnings?: string[] | null;
  metadata?: Record<string, unknown> | null;
  diagnostics?: Record<string, unknown> | null;
};

export type LlmResponseEnvelope = {
  ok: boolean;
  result?: LlmResponse | null;
  error?: { message?: string } | null;
};

export type Adapter = {
  provider: SupportedProvider;
  source: string;
  invoke: (params: {
    env: any;
    args: any;
    payload: Record<string, any>;
    signal?: AbortSignal;
  }) => Promise<LlmResponseEnvelope>;
};

export type DirectAdapter =
  | ((params: {
      env: any;
      args: any;
      payload: Record<string, any>;
      ctx: any;
    }) => Promise<LlmResponseEnvelope>)
  | {
      source?: string;
      invoke: (params: {
        env: any;
        args: any;
        payload: Record<string, any>;
        ctx: any;
      }) => Promise<LlmResponseEnvelope>;
    };

export type AdapterConfig = {
  name: string;
  sourceForProvider?: (provider: SupportedProvider) => string;
};

export function resolveProvider(
  args: any,
  env: any,
  defaultProvider?: SupportedProvider | null,
  ctx?: any,
): SupportedProvider {
  const explicit = String(args.provider ?? env.LOBSTER_LLM_PROVIDER ?? "")
    .trim()
    .toLowerCase();
  if (explicit) {
    if (explicit === "openclaw" || explicit === "pi" || explicit === "http") {
      return explicit;
    }
    if (getDirectAdapter(ctx, explicit)) {
      return explicit;
    }
    throw new Error(`Unsupported llm provider: ${explicit}`);
  }
  if (defaultProvider) return defaultProvider;
  const directAdapters =
    ctx?.llmAdapters && typeof ctx.llmAdapters === "object"
      ? Object.keys(ctx.llmAdapters).filter((key) => getDirectAdapter(ctx, key))
      : [];
  if (directAdapters.length === 1) return directAdapters[0];
  if (String(env.LOBSTER_PI_LLM_ADAPTER_URL ?? "").trim()) return "pi";
  if (String(env.OPENCLAW_URL ?? env.CLAWD_URL ?? "").trim()) return "openclaw";
  if (String(env.LOBSTER_LLM_ADAPTER_URL ?? "").trim()) return "http";
  return "openclaw";
}

export function resolveAdapter({
  provider,
  env,
  args,
  config,
  ctx,
}: {
  provider: SupportedProvider;
  env: any;
  args: any;
  config: AdapterConfig;
  ctx: any;
}): Adapter {
  const direct = getDirectAdapter(ctx, provider);
  if (direct) {
    const invoke = typeof direct === "function" ? direct : direct.invoke;
    return {
      provider,
      source: typeof direct === "function" ? provider : (direct.source ?? provider),
      async invoke({ payload }) {
        return invoke({ env, args, payload, ctx });
      },
    };
  }

  if (provider === "openclaw") {
    const openclawUrl = String(env.OPENCLAW_URL ?? env.CLAWD_URL ?? DEFAULT_OPENCLAW_URL).trim();
    const endpoint = new URL("/tools/invoke", openclawUrl);
    const token = String(args.token ?? env.OPENCLAW_TOKEN ?? env.CLAWD_TOKEN ?? "").trim();
    const sessionKey =
      args.sessionKey ?? args["session-key"] ?? env.LOBSTER_JOB_SESSION_KEY ?? null;
    const agent = args.agent ?? env.LOBSTER_JOB_AGENT ?? null;
    return {
      provider,
      source: config.sourceForProvider?.(provider) ?? "openclaw",
      async invoke({ payload }) {
        return invokeOpenClawAdapter({ endpoint, token, payload, sessionKey, agent });
      },
    };
  }

  if (provider === "pi") {
    const adapterUrl = String(env.LOBSTER_PI_LLM_ADAPTER_URL ?? "").trim();
    if (!adapterUrl) {
      throw new Error(`${config.name} requires LOBSTER_PI_LLM_ADAPTER_URL for provider=pi`);
    }
    const token = String(args.token ?? env.LOBSTER_PI_LLM_ADAPTER_TOKEN ?? "").trim();
    return {
      provider,
      source: config.sourceForProvider?.(provider) ?? "pi",
      async invoke({ payload }) {
        return invokeHttpAdapter({ endpoint: buildAdapterEndpoint(adapterUrl), token, payload });
      },
    };
  }

  const adapterUrl = String(env.LOBSTER_LLM_ADAPTER_URL ?? "").trim();
  if (!adapterUrl) {
    throw new Error(`${config.name} requires LOBSTER_LLM_ADAPTER_URL for provider=http`);
  }
  const token = String(args.token ?? env.LOBSTER_LLM_ADAPTER_TOKEN ?? "").trim();
  return {
    provider,
    source: config.sourceForProvider?.(provider) ?? "http",
    async invoke({ payload }) {
      return invokeHttpAdapter({ endpoint: buildAdapterEndpoint(adapterUrl), token, payload });
    },
  };
}

export function getDirectAdapter(ctx: any, provider: string): DirectAdapter | null {
  const adapters = ctx?.llmAdapters;
  if (!adapters || typeof adapters !== "object") return null;
  const adapter = adapters[provider];
  if (typeof adapter === "function") return adapter as DirectAdapter;
  if (adapter && typeof adapter === "object" && typeof adapter.invoke === "function") {
    return adapter as DirectAdapter;
  }
  return null;
}

export function buildAdapterEndpoint(rawUrl: string) {
  const endpoint = new URL(rawUrl);
  if (endpoint.pathname === "/" || endpoint.pathname === "") {
    endpoint.pathname = "/invoke";
  }
  return endpoint;
}

async function invokeOpenClawAdapter({
  endpoint,
  token,
  payload,
  sessionKey,
  agent,
}: {
  endpoint: URL;
  token: string;
  payload: any;
  sessionKey?: string | null;
  agent?: string | null;
}) {
  const args = toOpenClawToolArgs(payload);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : null),
    },
    body: JSON.stringify({
      tool: "llm-task",
      action: "invoke",
      args,
      ...(sessionKey ? { sessionKey: String(sessionKey) } : null),
      ...(agent ? { agent: String(agent) } : null),
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  }

  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new Error("Response was not JSON");
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "ok" in parsed) {
    if (parsed.ok !== true) {
      const msg = parsed?.error?.message ?? "Unknown error";
      throw new Error(`openclaw adapter error: ${msg}`);
    }
    const inner = parsed.result;
    if (inner && typeof inner === "object" && !Array.isArray(inner) && "ok" in inner) {
      const envelope = inner as LlmResponseEnvelope;
      return {
        ...envelope,
        result: envelope.result ? normalizeOpenClawToolResult(envelope.result) : envelope.result,
      };
    }
    return { ok: true, result: normalizeOpenClawToolResult(inner) } as LlmResponseEnvelope;
  }

  return { ok: true, result: parsed } as LlmResponseEnvelope;
}

function toOpenClawToolArgs(payload: Record<string, any>) {
  const { artifacts, ...args } = payload;
  const input = openClawInputFromArtifacts(artifacts);
  if (input !== undefined) args.input = input;
  return args;
}

function openClawInputFromArtifacts(artifacts: unknown) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) return undefined;
  if (artifacts.length === 1) return openClawInputFromArtifact(artifacts[0]);
  return artifacts.map(openClawInputFromArtifact);
}

function openClawInputFromArtifact(artifact: unknown) {
  if (artifact && typeof artifact === "object" && !Array.isArray(artifact)) {
    const item = artifact as Record<string, unknown>;
    if (typeof item.text === "string") return parseJsonTextOrRaw(item.text);
    if ("data" in item) return item.data;
  }
  return artifact;
}

function parseJsonTextOrRaw(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizeOpenClawToolResult(result: any): LlmResponse {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return {
      output: {
        text: result == null ? "" : String(result),
        data: result,
        format: "json",
      },
    };
  }

  if (result.output) {
    return result as LlmResponse;
  }

  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter((item: any) => item?.type === "text" && typeof item.text === "string")
    .map((item: any) => item.text)
    .join("\n");

  const details = result.details && typeof result.details === "object" ? result.details : null;
  const data = details && "json" in details ? details.json : undefined;

  return {
    ...result,
    model: result.model ?? details?.model ?? null,
    output: {
      text: text || null,
      data: data ?? null,
      format: data !== undefined ? "json" : "text",
    },
    metadata: {
      ...result.metadata,
      ...(details?.provider ? { provider: details.provider } : null),
      ...(details ? { details } : null),
    },
  } as LlmResponse;
}

async function invokeHttpAdapter({
  endpoint,
  token,
  payload,
}: {
  endpoint: URL;
  token: string;
  payload: any;
}) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : null),
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  }

  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new Error("Response was not JSON");
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "ok" in parsed) {
    return parsed as LlmResponseEnvelope;
  }
  return { ok: true, result: parsed } as LlmResponseEnvelope;
}

export function resolveModel(args: any, env: any, legacyEnvCompat?: boolean | undefined) {
  return resolveEnvString(
    args.model,
    ["LOBSTER_LLM_MODEL", "LOBSTER_JOB_MODEL", ...(legacyEnvCompat ? ["LLM_TASK_MODEL"] : [])],
    env,
    "",
  );
}

export function resolveEnvString(raw: any, envKeys: string[], env: any, fallback: string) {
  if (raw !== undefined && raw !== null && String(raw).trim()) return String(raw).trim();
  const fromEnv = getFirstEnv(env, envKeys);
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  return fallback;
}

export function getFirstEnv(env: any, keys: string[]) {
  for (const key of keys) {
    if (env?.[key] !== undefined && env?.[key] !== null && String(env[key]).trim()) {
      return env[key];
    }
  }
  return undefined;
}

/**
 * Resolve the configured LLM adapter and invoke it with a minimal text prompt,
 * returning the response text (or null when the adapter yields no text). Shares
 * the same provider/model/adapter resolution as `llm.invoke`, so job session /
 * agent / model defaults injected on `env` apply automatically.
 *
 * The call is bounded by `timeoutMs` (and any external `signal`): the combined
 * signal is forwarded to the adapter, and the promise is also raced against the
 * timeout so adapters that ignore the signal are still bounded. On expiry the
 * returned promise rejects with an AbortError.
 */
export async function invokeLlmText({
  ctx,
  env,
  prompt,
  model,
  signal,
  timeoutMs,
}: {
  ctx: any;
  env: Record<string, string | undefined>;
  prompt: string;
  model?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string | null> {
  const args: any = {};
  if (model) args.model = model;
  const provider = resolveProvider(args, env, null, ctx);
  const adapter = resolveAdapter({ provider, env, args, config: { name: "metadata.auto" }, ctx });
  const resolvedModel = resolveModel(args, env, false);
  const payload: Record<string, any> = {
    prompt,
    artifacts: [],
    artifactHashes: [],
    ...(resolvedModel ? { model: resolvedModel } : null),
  };

  const timeoutController = new AbortController();
  const hasTimeout = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (hasTimeout) {
    timer = setTimeout(
      () =>
        timeoutController.abort(
          new Error(`metadata auto-generation timed out after ${Math.floor(timeoutMs as number)}ms`),
        ),
      Math.floor(timeoutMs as number),
    );
  }
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;

  const abortPromise = new Promise<never>((_, reject) => {
    if (combinedSignal.aborted) {
      reject(combinedSignal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    combinedSignal.addEventListener(
      "abort",
      () => reject(combinedSignal.reason ?? new DOMException("The operation was aborted.", "AbortError")),
      { once: true },
    );
  });

  try {
    const envelope = await Promise.race([
      adapter.invoke({ env, args, payload, signal: combinedSignal }),
      abortPromise,
    ]);
    if (!envelope || envelope.ok !== true) {
      throw new Error(envelope?.error?.message ?? "llm adapter returned an error");
    }
    const output = envelope.result?.output;
    const text = typeof output?.text === "string" ? output.text.trim() : "";
    if (text) return text;
    const data = output?.data;
    if (typeof data === "string" && data.trim()) return data.trim();
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
