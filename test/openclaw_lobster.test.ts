import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createDefaultRegistry } from "../src/commands/registry.js";

function streamOf(items: unknown[]) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

function cleanEnv() {
  return {
    ...process.env,
    LOBSTER_JOB_AGENT: undefined,
    LOBSTER_JOB_MODEL: undefined,
    LOBSTER_JOB_SESSION_KEY: undefined,
  };
}

function commandCtx(registry: ReturnType<typeof createDefaultRegistry>, env = cleanEnv()): any {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env,
    registry,
    mode: "tool",
    render: { json() {}, lines() {} },
  };
}

test("openclaw.lobster is registered", async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get("openclaw.lobster");
  assert.ok(cmd, "expected openclaw.lobster to exist");
  assert.equal(typeof cmd.run, "function");
  assert.ok(cmd.meta.argsSchema.properties.agent);
  assert.ok(cmd.meta.argsSchema.properties.model);
  assert.ok(cmd.meta.argsSchema.properties["session-key"]);
  assert.equal("action" in cmd.meta.argsSchema.properties, false);
});

test("openclaw.lobster posts to /tools/invoke with tool=lobster and args from --args-json", async () => {
  let received: any;
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/tools/invoke") {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ ok: true, result: [{ ok: true, status: "paused", jobId: "job-1" }] }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const addr = server.address();
  const port = typeof addr === "string" || addr == null ? 0 : addr.port;

  try {
    const registry = createDefaultRegistry();
    const cmd = registry.get("openclaw.lobster");

    const result = await cmd.run({
      input: streamOf([]),
      args: {
        _: ["run"],
        url: `http://127.0.0.1:${port}`,
        "args-json": '{"filePath":"workflows/x.lobster","createSession":true,"stepMode":true}',
      },
      ctx: commandCtx(registry),
    });

    const items: unknown[] = [];
    for await (const it of result.output) items.push(it);

    assert.equal(received.tool, "lobster");
    assert.equal(received.action, "run");
    assert.deepEqual(received.args, {
      filePath: "workflows/x.lobster",
      createSession: true,
      stepMode: true,
    });
    assert.deepEqual(items, [{ ok: true, status: "paused", jobId: "job-1" }]);
  } finally {
    server.close();
  }
});

test("openclaw.lobster overrides any provided --tool to lobster", async () => {
  let received: any;
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: [{ ok: true }] }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const addr = server.address();
  const port = typeof addr === "string" || addr == null ? 0 : addr.port;

  try {
    const registry = createDefaultRegistry();
    const cmd = registry.get("openclaw.lobster");

    const result = await cmd.run({
      input: streamOf([]),
      args: {
        _: ["listJobs"],
        url: `http://127.0.0.1:${port}`,
        tool: "message",
      },
      ctx: commandCtx(registry),
    });

    const items: unknown[] = [];
    for await (const it of result.output) items.push(it);
    assert.equal(received.tool, "lobster");
    assert.equal(received.action, "listJobs");
  } finally {
    server.close();
  }
});

test("openclaw.lobster rejects unknown actions", async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get("openclaw.lobster");

  await assert.rejects(
    () =>
      cmd.run({
        input: streamOf([]),
        args: { _: ["bogus"], url: "http://127.0.0.1:1" },
        ctx: commandCtx(registry),
      }),
    /action must be one of/,
  );
});

test("openclaw.lobster requires positional action and rejects --action", async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get("openclaw.lobster");

  await assert.rejects(
    () =>
      cmd.run({
        input: streamOf([]),
        args: { _: [], url: "http://127.0.0.1:1" },
        ctx: commandCtx(registry),
      }),
    /requires action as the first positional argument/,
  );

  await assert.rejects(
    () =>
      cmd.run({
        input: streamOf([]),
        args: { _: ["run"], action: "run", url: "http://127.0.0.1:1" },
        ctx: commandCtx(registry),
      }),
    /not --action/,
  );
});

test("openclaw.lobster rejects extra positional args", async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get("openclaw.lobster");

  await assert.rejects(
    () =>
      cmd.run({
        input: streamOf([]),
        args: { _: ["run", "extra"], url: "http://127.0.0.1:1" },
        ctx: commandCtx(registry),
      }),
    /exactly one positional action/,
  );
});

test("openclaw.lobster run forwards CLI job context for persistence", async () => {
  let received: any;
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: [{ ok: true }] }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const addr = server.address();
  const port = typeof addr === "string" || addr == null ? 0 : addr.port;

  try {
    const registry = createDefaultRegistry();
    const cmd = registry.get("openclaw.lobster");

    const result = await cmd.run({
      input: streamOf([]),
      args: {
        _: ["run"],
        url: `http://127.0.0.1:${port}`,
        agent: "researcher",
        model: "gpt-5",
        "session-key": "user:chat:abc",
        "args-json": '{"filePath":"workflows/x.lobster"}',
      },
      ctx: commandCtx(registry),
    });

    for await (const _it of result.output) {
      // drain
    }
    assert.equal(received.agent, "researcher");
    assert.equal(received.model, "gpt-5");
    assert.equal(received.sessionKey, "user:chat:abc");
    assert.deepEqual(received.args, {
      filePath: "workflows/x.lobster",
      agent: "researcher",
      model: "gpt-5",
      sessionKey: "user:chat:abc",
    });
  } finally {
    server.close();
  }
});

test("openclaw.lobster rejects context keys inside --args-json", async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get("openclaw.lobster");

  for (const key of ["agent", "model", "sessionKey", "session-key"]) {
    await assert.rejects(
      () =>
        cmd.run({
          input: streamOf([]),
          args: {
            _: ["run"],
            url: "http://127.0.0.1:1",
            "args-json": JSON.stringify({ filePath: "workflows/x.lobster", [key]: "bad" }),
          },
          ctx: commandCtx(registry),
        }),
      new RegExp(`${key} must be passed as a CLI flag`),
    );
  }
});

test("openclaw.lobster rejects explicit context flags on non-run actions", async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get("openclaw.lobster");

  await assert.rejects(
    () =>
      cmd.run({
        input: streamOf([]),
        args: { _: ["listJobs"], url: "http://127.0.0.1:1", agent: "researcher" },
        ctx: commandCtx(registry),
      }),
    /only valid for run/,
  );
});

test("openclaw.lobster applies job env defaults only for run", async () => {
  const received: any[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: [{ ok: true }] }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const addr = server.address();
  const port = typeof addr === "string" || addr == null ? 0 : addr.port;

  try {
    const registry = createDefaultRegistry();
    const cmd = registry.get("openclaw.lobster");
    const env = {
      ...process.env,
      LOBSTER_JOB_AGENT: "env-agent",
      LOBSTER_JOB_MODEL: "env-model",
      LOBSTER_JOB_SESSION_KEY: "env-session",
    };

    let result = await cmd.run({
      input: streamOf([]),
      args: {
        _: ["run"],
        url: `http://127.0.0.1:${port}`,
        "args-json": '{"filePath":"workflows/x.lobster"}',
      },
      ctx: commandCtx(registry, env),
    });
    for await (const _it of result.output) {
      // drain
    }

    result = await cmd.run({
      input: streamOf([]),
      args: {
        _: ["listJobs"],
        url: `http://127.0.0.1:${port}`,
        "args-json": '{"status":"waiting"}',
      },
      ctx: commandCtx(registry, env),
    });
    for await (const _it of result.output) {
      // drain
    }

    assert.equal(received[0].agent, "env-agent");
    assert.equal(received[0].model, "env-model");
    assert.equal(received[0].sessionKey, "env-session");
    assert.equal(received[0].args.agent, "env-agent");
    assert.equal(received[0].args.model, "env-model");
    assert.equal(received[0].args.sessionKey, "env-session");
    assert.equal("agent" in received[1], false);
    assert.equal("model" in received[1], false);
    assert.equal("sessionKey" in received[1], false);
    assert.deepEqual(received[1].args, { status: "waiting" });
  } finally {
    server.close();
  }
});
