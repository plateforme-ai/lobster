import { createHash } from "node:crypto";

const DEFAULT_PREVIEW_BYTES = 16_384;

const SECRET_KEY_RE =
  /(token|secret|password|passwd|pwd|api[_-]?key|bearer|authorization|oauth|cookie|session|private[_-]?key|openclaw[_-]?token|clawd[_-]?token)/i;

const SECRET_VALUE_RES = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|pk|ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{12,}\b/g,
];

export type SerializedPayload = {
  value: unknown;
  json: string;
  byteLength: number;
  sha256: string;
  preview: unknown;
  previewJson: string;
  truncated: boolean;
};

export function redactSecrets(value: unknown): unknown {
  return redactValue(value, new WeakSet());
}

export function serializeBounded(
  value: unknown,
  options: { previewBytes?: number } = {},
): SerializedPayload {
  const redacted = redactSecrets(value);
  const json = stringifySafe(redacted);
  const byteLength = Buffer.byteLength(json, "utf8");
  const previewBytes = options.previewBytes ?? DEFAULT_PREVIEW_BYTES;
  const truncated = byteLength > previewBytes;
  const preview = truncated
    ? {
        truncated: true,
        bytes: byteLength,
        preview: json.slice(0, previewBytes),
      }
    : redacted;
  const previewJson = stringifySafe(preview);
  return {
    value: redacted,
    json,
    byteLength,
    sha256: createHash("sha256").update(json).digest("hex"),
    preview,
    previewJson,
    truncated,
  };
}

export function stringifySafe(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify("[unserializable]");
  }
}

export function parseJsonSafe(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = redactValue(child, seen);
    }
  }
  return out;
}

function redactString(value: string) {
  let out = value;
  for (const re of SECRET_VALUE_RES) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}
