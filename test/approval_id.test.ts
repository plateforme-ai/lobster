import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function runCli(args: string[], env: Record<string, string | undefined>) {
  const bin = path.join(process.cwd(), "bin", "lobster.js");
  return spawnSync("node", [bin, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("approval gate returns approvalId alongside resumeToken", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-aid-"));
  const stateDir = path.join(tmpDir, "state");

  const pipeline =
    'exec --json=true node -e "process.stdout.write(JSON.stringify([{a:1}]))" | approve --prompt "ok?" | pick a';

  const first = runCli(["run", "--mode", "tool", pipeline], { LOBSTER_DIR: tmpDir });
  assert.equal(first.status, 0);
  const json = JSON.parse(first.stdout);
  assert.equal(json.status, "needs_approval");
  assert.ok(json.requiresApproval?.resumeToken, "should have resumeToken");
  assert.ok(json.requiresApproval?.approvalId, "should have approvalId");
  assert.equal(json.requiresApproval.approvalId.length, 8, "approvalId should be 8 hex chars");
  assert.match(json.requiresApproval.approvalId, /^[a-f0-9]{8}$/, "approvalId should be hex");
});

test("resume with --id works as alternative to --token", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-aid-resume-"));
  const stateDir = path.join(tmpDir, "state");

  const pipeline =
    'exec --json=true node -e "process.stdout.write(JSON.stringify([{b:2}]))" | approve --prompt "ok?" | pick b';

  const first = runCli(["run", "--mode", "tool", pipeline], { LOBSTER_DIR: tmpDir });
  assert.equal(first.status, 0);
  const firstJson = JSON.parse(first.stdout);
  assert.equal(firstJson.status, "needs_approval");
  const approvalId = firstJson.requiresApproval.approvalId;
  assert.ok(approvalId);

  const resumed = runCli(["resume", "--id", approvalId, "--approve", "yes"], {
    LOBSTER_DIR: tmpDir,
  });
  assert.equal(resumed.status, 0, `stderr: ${resumed.stderr}`);
  const resumedJson = JSON.parse(resumed.stdout);
  assert.equal(resumedJson.status, "ok");
  assert.deepEqual(resumedJson.output, [{ b: 2 }]);
});

test("resume with --id cancellation works", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-aid-cancel-"));
  const stateDir = path.join(tmpDir, "state");

  const pipeline =
    'exec --json=true node -e "process.stdout.write(JSON.stringify([{c:3}]))" | approve --prompt "ok?" | pick c';

  const first = runCli(["run", "--mode", "tool", pipeline], { LOBSTER_DIR: tmpDir });
  const firstJson = JSON.parse(first.stdout);
  const approvalId = firstJson.requiresApproval.approvalId;

  const cancelled = runCli(["resume", "--id", approvalId, "--approve", "no"], {
    LOBSTER_DIR: tmpDir,
  });
  assert.equal(cancelled.status, 0);
  const cancelledJson = JSON.parse(cancelled.stdout);
  assert.equal(cancelledJson.status, "cancelled");
});

test("resume with invalid --id returns clear error", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-aid-invalid-"));
  const stateDir = path.join(tmpDir, "state");

  const result = runCli(["resume", "--id", "deadbeef", "--approve", "yes"], {
    LOBSTER_DIR: tmpDir,
  });
  const json = JSON.parse(result.stdout);
  assert.equal(json.ok, false);
  assert.ok(
    json.error?.message?.includes("not found"),
    `Error should mention not found: ${json.error?.message}`,
  );
});

test("--token resume works when approvalId is also present", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-aid-orphan-"));
  const stateDir = path.join(tmpDir, "state");

  const pipeline =
    'exec --json=true node -e "process.stdout.write(JSON.stringify([{e:5}]))" | approve --prompt "ok?" | pick e';

  const first = runCli(["run", "--mode", "tool", pipeline], { LOBSTER_DIR: tmpDir });
  const firstJson = JSON.parse(first.stdout);
  assert.ok(firstJson.requiresApproval?.approvalId);
  assert.ok(firstJson.requiresApproval?.resumeToken);

  const resumed = runCli(
    ["resume", "--token", firstJson.requiresApproval.resumeToken, "--approve", "yes"],
    { LOBSTER_DIR: tmpDir },
  );
  assert.equal(resumed.status, 0);
  const resumedJson = JSON.parse(resumed.stdout);
  assert.equal(resumedJson.status, "ok");
});

test("double-resume with same --id returns clear error", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-aid-double-"));
  const stateDir = path.join(tmpDir, "state");

  const pipeline =
    'exec --json=true node -e "process.stdout.write(JSON.stringify([{f:6}]))" | approve --prompt "ok?" | pick f';

  const first = runCli(["run", "--mode", "tool", pipeline], { LOBSTER_DIR: tmpDir });
  const firstJson = JSON.parse(first.stdout);
  const approvalId = firstJson.requiresApproval.approvalId;

  // First resume — should succeed.
  const resumed = runCli(["resume", "--id", approvalId, "--approve", "yes"], {
    LOBSTER_DIR: tmpDir,
  });
  assert.equal(resumed.status, 0);
  const resumedJson = JSON.parse(resumed.stdout);
  assert.equal(resumedJson.status, "ok");

  // Second resume with same id — the approval is no longer waiting, so it
  // resolves to nothing and fails cleanly rather than replaying the run.
  const second = runCli(["resume", "--id", approvalId, "--approve", "yes"], {
    LOBSTER_DIR: tmpDir,
  });
  const secondJson = JSON.parse(second.stdout);
  assert.equal(secondJson.ok, false);
  assert.ok(
    secondJson.error?.message?.includes("not found"),
    `Should report not found: ${secondJson.error?.message}`,
  );
});

test("backward compat: --token still works when approvalId is present", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-aid-compat-"));
  const stateDir = path.join(tmpDir, "state");

  const pipeline =
    'exec --json=true node -e "process.stdout.write(JSON.stringify([{d:4}]))" | approve --prompt "ok?" | pick d';

  const first = runCli(["run", "--mode", "tool", pipeline], { LOBSTER_DIR: tmpDir });
  const firstJson = JSON.parse(first.stdout);
  assert.ok(firstJson.requiresApproval?.approvalId, "approvalId present");
  assert.ok(firstJson.requiresApproval?.resumeToken, "resumeToken present");

  const resumed = runCli(
    ["resume", "--token", firstJson.requiresApproval.resumeToken, "--approve", "yes"],
    { LOBSTER_DIR: tmpDir },
  );
  assert.equal(resumed.status, 0);
  const resumedJson = JSON.parse(resumed.stdout);
  assert.equal(resumedJson.status, "ok");
  assert.deepEqual(resumedJson.output, [{ d: 4 }]);
});
