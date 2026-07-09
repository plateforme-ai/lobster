import path from "node:path";
import { promises as fsp } from "node:fs";

import { defaultStateDir, ensureDirectory, writeFileAtomic } from "./state.js";
import { serializeBounded, type SerializedPayload } from "./serialization.js";

export type StoredPayload = {
  inlineJson: string | null;
  blobId: string | null;
  previewJson: string;
  sha256: string;
  byteLength: number;
};

export function blobRoot(env: Record<string, string | undefined>) {
  return path.join(defaultStateDir(env), "blobs", "sha256");
}

export async function writeContentAddressedBlob(params: {
  env: Record<string, string | undefined>;
  payload: SerializedPayload;
  contentType?: string;
}) {
  const hash = params.payload.sha256;
  const prefix = hash.slice(0, 2);
  const dir = path.join(blobRoot(params.env), prefix);
  const filePath = path.join(dir, hash);
  await ensureDirectory(dir);
  try {
    await fsp.access(filePath);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
    await writeFileAtomic(filePath, params.payload.json);
  }
  return {
    blobId: hash,
    sha256: hash,
    byteLength: params.payload.byteLength,
    contentType: params.contentType ?? "application/json",
    storagePath: path.relative(defaultStateDir(params.env), filePath),
    createdAt: new Date().toISOString(),
  };
}

export async function storePayload(params: {
  env: Record<string, string | undefined>;
  value: unknown;
  inlineMaxBytes: number;
  previewBytes?: number;
  contentType?: string;
}): Promise<StoredPayload & { blob?: Awaited<ReturnType<typeof writeContentAddressedBlob>> }> {
  const payload = serializeBounded(params.value, { previewBytes: params.previewBytes });
  if (payload.byteLength <= params.inlineMaxBytes) {
    return {
      inlineJson: payload.json,
      blobId: null,
      previewJson: payload.previewJson,
      sha256: payload.sha256,
      byteLength: payload.byteLength,
    };
  }

  const blob = await writeContentAddressedBlob({
    env: params.env,
    payload,
    contentType: params.contentType,
  });
  return {
    inlineJson: null,
    blobId: blob.blobId,
    previewJson: payload.previewJson,
    sha256: payload.sha256,
    byteLength: payload.byteLength,
    blob,
  };
}

export async function readBlobJson(params: {
  env: Record<string, string | undefined>;
  blobId: string;
}) {
  const filePath = path.join(blobRoot(params.env), params.blobId.slice(0, 2), params.blobId);
  const text = await fsp.readFile(filePath, "utf8");
  return JSON.parse(text);
}
