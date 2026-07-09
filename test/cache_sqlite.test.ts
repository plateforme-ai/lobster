import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDefaultRegistry } from "../src/commands/registry.js";

function streamOf(items: unknown[]) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

async function collect(iterable: AsyncIterable<unknown>) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items as any[];
}

function baseCtx(env: Record<string, string>, registry: any) {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: { ...process.env, ...env },
    registry,
    mode: "tool",
    render: { json() {}, lines() {} },
  };
}

test("llm_task.invoke uses sqlite cache with TTL metadata", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cache-sqlite-"));
  const registry = createDefaultRegistry();
  const cmd = registry.get("llm_task.invoke");
  assert.ok(cmd);

  let calls = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/tools/invoke") {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    req.resume();
    req.on("end", () => {
      calls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          result: { ok: true, result: { runId: `r${calls}`, output: { data: { calls } } } },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  let closed = false;
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  try {
    const env = {
      LOBSTER_DIR: tmpDir,
      LOBSTER_CACHE_TTL_DAYS: "7",
      CLAWD_URL: `http://localhost:${port}`,
    };
    const args = { _: [], model: "claude", prompt: "Do cached thing" };

    const first = await cmd.run({
      input: streamOf([{ foo: "bar" }]),
      args,
      ctx: baseCtx(env, registry),
    });
    const firstItems = await collect(first.output!);
    assert.equal(firstItems[0].source, "clawd");

    await new Promise<void>((resolve) =>
      server.close(() => {
        closed = true;
        resolve();
      }),
    );

    const second = await cmd.run({
      input: streamOf([{ foo: "bar" }]),
      args,
      ctx: baseCtx(env, registry),
    });
    const secondItems = await collect(second.output!);
    assert.equal(secondItems[0].source, "cache");
    assert.equal(calls, 1);
  } finally {
    if (!closed) server.close();
  }
});
