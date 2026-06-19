import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = process.cwd();

function runBin(binName: string, ...args: string[]) {
  return spawnSync(process.execPath, [path.join(repoRoot, "bin", binName), ...args], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
  });
}

test("openclaw.lobster --help routes to command help and exits 0", () => {
  const res = runBin("openclaw.lobster.js", "--help");
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /openclaw\.lobster/);
  assert.match(res.stdout, /openclaw\.lobster run/);
  assert.match(res.stdout, /--agent/);
  assert.match(res.stdout, /--model/);
  assert.match(res.stdout, /--session-key/);
});

test("openclaw.invoke --help routes to command help and exits 0", () => {
  const res = runBin("openclaw.invoke.js", "--help");
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /openclaw\.invoke/);
  assert.match(res.stdout, /--tool message/);
});

test("clawd.invoke --help routes to command help and exits 0", () => {
  const res = runBin("clawd.invoke.js", "--help");
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /clawd\.invoke/);
  assert.match(res.stdout, /--tool message/);
});
