import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  listJobCheckpoints,
  listJobSteps,
  resumeToolRequest,
  runToolRequest,
} from "../src/core/index.js";
import { getJob, getRun } from "../src/store/runtime_store.js";
import { withRuntimeDb } from "../src/store/sqlite.js";

async function writeWorkflows(tmpDir: string, files: Record<string, unknown>) {
  for (const [name, content] of Object.entries(files)) {
    await fsp.writeFile(path.join(tmpDir, name), JSON.stringify(content, null, 2), "utf8");
  }
}

test("nested approval bubbles up through the tool envelope and resumes to completion", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-nested-approve-"));
  await writeWorkflows(tmpDir, {
    "child.lobster": {
      steps: [
        {
          id: "x",
          command: 'node -e "process.stdout.write(JSON.stringify({v:1}))"',
          approval: true,
        },
      ],
    },
    "parent.lobster": {
      steps: [{ id: "sub", workflow: "child.lobster" }],
    },
  });

  const env = {
    ...process.env,
    LOBSTER_DIR: tmpDir,
  };

  const first = await runToolRequest({
    filePath: path.join(tmpDir, "parent.lobster"),
    ctx: { cwd: tmpDir, env },
  });
  assert.equal(first.status, "needs_approval");
  assert.ok(first.jobId);
  assert.ok(first.runId);
  assert.ok(first.requiresApproval?.resumeToken);

  // Root job and root run should both be parked in a waiting state.
  const waitingJob = await getJob(env, first.jobId!);
  assert.equal(waitingJob?.status, "waiting");
  const waitingRun = await getRun(env, first.runId!);
  assert.equal(waitingRun?.status, "waiting");

  const resumed = await resumeToolRequest({
    token: first.requiresApproval!.resumeToken,
    approved: true,
    ctx: { cwd: tmpDir, env },
  });
  assert.equal(resumed.status, "ok");
  assert.deepEqual(resumed.output, [{ v: 1 }]);
  assert.equal(resumed.jobId, first.jobId);

  const doneJob = await getJob(env, first.jobId!);
  assert.equal(doneJob?.status, "succeeded");
});

test("nested suspension exposes the child gate as the only visible waiting step", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-nested-single-"));
  await writeWorkflows(tmpDir, {
    "child.lobster": {
      steps: [
        {
          id: "x",
          command: 'node -e "process.stdout.write(JSON.stringify({v:1}))"',
          approval: true,
        },
      ],
    },
    "parent.lobster": {
      steps: [{ id: "sub", workflow: "child.lobster" }],
    },
  });

  const env = { ...process.env, LOBSTER_DIR: tmpDir };
  const ctx = { cwd: tmpDir, env };

  const first = await runToolRequest({ filePath: path.join(tmpDir, "parent.lobster"), ctx });
  assert.equal(first.status, "needs_approval");

  // The single wait/approval lives on the child gate that triggered the
  // suspension. The parent `nested` frame is a pure call-stack marker and is
  // skipped by the head-wait resolver, so the job head wait resolves directly to
  // the child gate (step `x`), not the parent frame.
  const job = await getJob(env, first.jobId!);
  assert.equal(job?.wait?.kind, "approval");
  assert.equal(job?.wait?.stepId, "x", "the head wait is the child gate step");

  const checkpoints = await listJobCheckpoints({ jobId: first.jobId!, ctx });
  const waitingNested = checkpoints.filter((c) => c.kind === "nested" && c.status === "waiting");
  const waitingGates = checkpoints.filter(
    (c) => c.kind === "gate" && c.name === "approval" && c.status === "waiting",
  );
  assert.equal(waitingNested.length, 1, "exactly one parent call-stack frame is recorded");
  assert.equal(waitingNested[0].stepPath, "root.sub");
  assert.equal(waitingGates.length, 1, "the child gate is the real waiting suspension");
  assert.equal(waitingGates[0].stepPath, "root.sub.x");
  assert.equal(
    job?.wait?.checkpointId,
    waitingGates[0].checkpointId,
    "the head wait anchors on the child gate checkpoint, not the parent frame",
  );

  // The child gate's approval must be the surviving waiting approval (there is
  // exactly one approval record; no parent-anchored duplicate is created).
  const approvals = await withRuntimeDb(
    env,
    (db) =>
      db
        .prepare("SELECT checkpoint_id, status FROM approvals WHERE job_id = ?")
        .all(first.jobId) as Array<{ checkpoint_id: string; status: string }>,
  );
  assert.equal(approvals.length, 1, "a single approval record backs the nested suspension");
  assert.equal(approvals[0].status, "waiting");
  assert.equal(
    approvals[0].checkpoint_id,
    waitingGates[0].checkpointId,
    "the approval is anchored on the child gate",
  );

  // Folding the full lineage surfaces the child workflow's own step but never a
  // folded step for the parent resume anchor: the workflow-call path carries only
  // the `nested` checkpoint (skipped by the fold) while it is suspended, so it
  // must not double up as a second row alongside the child.
  const steps = await listJobSteps({ jobId: first.jobId!, allRuns: true, ctx });
  const paths = steps.map((s) => s.stepPath);
  assert.ok(paths.includes("root.sub.x"), "the child workflow step is folded from its child run");
  assert.ok(
    !steps.some((s) => s.stepPath === "root.sub"),
    "the nested parent anchor is not folded into a visible step",
  );
});

test("nested approval reject through the tool envelope cancels the job and records a rejection", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-nested-reject-"));
  await writeWorkflows(tmpDir, {
    "child.lobster": {
      steps: [
        {
          id: "x",
          command: 'node -e "process.stdout.write(JSON.stringify({v:1}))"',
          approval: true,
        },
      ],
    },
    "parent.lobster": {
      steps: [{ id: "sub", workflow: "child.lobster" }],
    },
  });

  const env = {
    ...process.env,
    LOBSTER_DIR: tmpDir,
  };

  const first = await runToolRequest({
    filePath: path.join(tmpDir, "parent.lobster"),
    ctx: { cwd: tmpDir, env },
  });
  assert.equal(first.status, "needs_approval");

  const rejected = await resumeToolRequest({
    token: first.requiresApproval!.resumeToken,
    approved: false,
    ctx: { cwd: tmpDir, env },
  });
  assert.equal(rejected.status, "cancelled");

  const job = await getJob(env, first.jobId!);
  assert.equal(job?.status, "cancelled");

  const approvals = await withRuntimeDb(
    env,
    (db) =>
      db
        .prepare("SELECT status, decision FROM approvals WHERE job_id = ?")
        .all(first.jobId) as Array<{ status: string; decision: string | null }>,
  );
  assert.ok(approvals.length >= 1);
  assert.ok(
    approvals.some((row) => row.status === "rejected" && row.decision === "reject"),
    `expected a rejected approval, saw ${JSON.stringify(approvals)}`,
  );
});

test("three-level nesting resumes child-first and walks up through every parent", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-nested-3lvl-"));
  await writeWorkflows(tmpDir, {
    "child.lobster": {
      steps: [
        {
          id: "x",
          command: 'node -e "process.stdout.write(JSON.stringify({v:1}))"',
          approval: true,
        },
      ],
    },
    "parent.lobster": {
      steps: [
        { id: "c", workflow: "child.lobster" },
        { id: "pdone", command: 'node -e "process.stdout.write(JSON.stringify({p:true}))"' },
      ],
    },
    "grandparent.lobster": {
      steps: [
        { id: "p", workflow: "parent.lobster" },
        { id: "gdone", command: 'node -e "process.stdout.write(JSON.stringify({g:true}))"' },
      ],
    },
  });

  const env = { ...process.env, LOBSTER_DIR: tmpDir };
  const ctx = { cwd: tmpDir, env };

  const first = await runToolRequest({
    filePath: path.join(tmpDir, "grandparent.lobster"),
    ctx,
  });
  assert.equal(first.status, "needs_approval");

  // The deepest child gate (leaf step `x`) fronts the wait; both ancestors hold
  // pure call-stack frames only.
  const job = await getJob(env, first.jobId!);
  assert.equal(job?.wait?.kind, "approval");
  assert.equal(job?.wait?.stepId, "x");

  const checkpoints = await listJobCheckpoints({ jobId: first.jobId!, ctx });
  const waitingNested = checkpoints.filter((c) => c.kind === "nested" && c.status === "waiting");
  const waitingGates = checkpoints.filter(
    (c) => c.kind === "gate" && c.name === "approval" && c.status === "waiting",
  );
  assert.equal(waitingNested.length, 2, "one call-stack frame per ancestor (grandparent, parent)");
  assert.deepEqual(
    waitingNested.map((c) => c.stepPath).sort(),
    ["root.p", "root.p.c"],
    "frames are anchored on each parent's workflow-call step",
  );
  assert.equal(waitingGates.length, 1, "only the leaf child gate is a real waiting suspension");
  assert.equal(waitingGates[0].stepPath, "root.p.c.x");

  // Approving the child resumes it, then the walk-up continues each parent past
  // its workflow-call step and runs the trailing steps up to the root output.
  const resumed = await resumeToolRequest({
    token: first.requiresApproval!.resumeToken,
    approved: true,
    ctx,
  });
  assert.equal(resumed.status, "ok");
  assert.deepEqual(resumed.output, [{ g: true }]);
  assert.equal(resumed.jobId, first.jobId);

  const doneJob = await getJob(env, first.jobId!);
  assert.equal(doneJob?.status, "succeeded");

  // Every workflow-call step is folded as a succeeded step once the walk-up
  // completes, alongside the trailing steps it enabled.
  const steps = await listJobSteps({ jobId: first.jobId!, allRuns: true, ctx });
  const paths = steps.map((s) => s.stepPath);
  for (const p of ["root.p.c.x", "root.p.c", "root.p.pdone", "root.p", "root.gdone"]) {
    assert.ok(paths.includes(p), `expected folded step ${p}, saw ${JSON.stringify(paths)}`);
  }
});
