import { Writable } from "node:stream";
import path from "node:path";

import { createDefaultRegistry } from "../commands/registry.js";
import { parsePipeline } from "../parser.js";
import { decodeResumeToken, kindFromStateKey } from "../resume.js";
import { runPipeline } from "../runtime.js";
import { encodeToken } from "../token.js";
import {
  deleteStateJson,
  deleteApprovalId,
  findStateKeyByApprovalId,
  cleanupApprovalIndexByStateKey,
} from "../state/store.js";
import { WorkflowResumeArgumentError, runWorkflowFile } from "../workflows/file.js";
import {
  finalizePipelineToolRun,
  loadPipelineResumeState,
  validatePipelineInputResponse,
} from "../pipeline_resume_state.js";
import {
  checkpointsEnabled,
  createCheckpointRun,
  createRun,
  getCheckpoint as getStoredCheckpoint,
  getJob as getStoredJob,
  getRun as getStoredRun,
  listJobCheckpoints as listStoredJobCheckpoints,
  listJobRuns as listStoredJobRuns,
  listJobs as listStoredJobs,
  listPendingApprovals as listStoredPendingApprovals,
  listRunCheckpoints as listStoredRunCheckpoints,
  getCheckpointIO as getStoredCheckpointIO,
  resolveApprovalRecord,
  updateRun,
} from "../store/runtime_store.js";
import type { WorkflowExecutionContext } from "../checkpoints/types.js";

type ToolRunContext = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  mode?: "tool" | "human" | "sdk";
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  signal?: AbortSignal;
  registry?: any;
  llmAdapters?: Record<string, any>;
};

type ToolEnvelope = {
  protocolVersion: 1;
  ok: boolean;
  status?: "ok" | "needs_approval" | "needs_input" | "cancelled";
  output?: unknown[];
  jobId?: string;
  runId?: string;
  rootRunId?: string;
  parentRunId?: string | null;
  checkpointId?: string | null;
  latestCheckpointId?: string | null;
  requiresApproval?: {
    type?: "approval_request";
    prompt: string;
    items: unknown[];
    preview?: string;
    resumeToken?: string;
    approvalId?: string;
  } | null;
  requiresInput?: {
    type?: "input_request";
    prompt: string;
    responseSchema: unknown;
    defaults?: unknown;
    subject?: unknown;
    resumeToken?: string;
  } | null;
  error?: {
    type: string;
    message: string;
  };
};

export async function runToolRequest({
  pipeline,
  filePath,
  args,
  ctx = {},
  lineage = {},
}: {
  pipeline?: string;
  filePath?: string;
  args?: Record<string, unknown>;
  ctx?: ToolRunContext;
  lineage?: {
    parentRunId?: string | null;
    rerunOfJobId?: string | null;
    rewindOfJobId?: string | null;
    rewindOfCheckpointId?: string | null;
  };
}): Promise<ToolEnvelope> {
  const runtime = createToolContext(ctx);
  let checkpointRun: WorkflowExecutionContext | undefined;
  const hasPipeline = typeof pipeline === "string" && pipeline.trim().length > 0;
  const hasFile = typeof filePath === "string" && filePath.trim().length > 0;

  if (!hasPipeline && !hasFile) {
    return errorEnvelope("parse_error", "run requires either pipeline or filePath");
  }
  if (hasPipeline && hasFile) {
    return errorEnvelope("parse_error", "run accepts either pipeline or filePath, not both");
  }

  if (hasFile) {
    let resolvedFilePath: string;
    try {
      resolvedFilePath = await resolveWorkflowFile(filePath!, runtime.cwd);
    } catch (err: any) {
      return errorEnvelope("parse_error", err?.message ?? String(err));
    }

    try {
      checkpointRun = await maybeCreateRun({
        runtime,
        sourceType: "workflow_file",
        workflowFile: resolvedFilePath,
        args,
        lineage,
      });
      const output = await runWorkflowFile({
        filePath: resolvedFilePath,
        args,
        ctx: { ...runtime, checkpointRun },
      });

      if (output.status === "needs_approval") {
        await maybeUpdateRun(runtime, checkpointRun, "waiting");
        return okEnvelope(
          "needs_approval",
          [],
          output.requiresApproval ?? null,
          null,
          checkpointRun,
        );
      }
      if (output.status === "needs_input") {
        await maybeUpdateRun(runtime, checkpointRun, "waiting");
        return okEnvelope("needs_input", [], null, output.requiresInput ?? null, checkpointRun);
      }
      if (output.status === "cancelled") {
        await maybeUpdateRun(runtime, checkpointRun, "cancelled");
        return okEnvelope("cancelled", [], null, null, checkpointRun);
      }
      await maybeUpdateRun(runtime, checkpointRun, "succeeded", output.output);
      return okEnvelope("ok", output.output, null, null, checkpointRun);
    } catch (err: any) {
      await maybeUpdateRun(runtime, checkpointRun, "failed");
      return errorEnvelope("runtime_error", err?.message ?? String(err));
    }
  }

  let parsed;
  try {
    parsed = parsePipeline(String(pipeline));
  } catch (err: any) {
    return errorEnvelope("parse_error", err?.message ?? String(err));
  }

  try {
    checkpointRun = await maybeCreateRun({
      runtime,
      sourceType: "pipeline",
      pipelineText: String(pipeline),
      args,
      lineage,
    });
    const output = await runPipeline({
      pipeline: parsed,
      registry: runtime.registry,
      input: [],
      stdin: runtime.stdin,
      stdout: runtime.stdout,
      stderr: runtime.stderr,
      env: runtime.env,
      mode: "tool",
      cwd: runtime.cwd,
      llmAdapters: runtime.llmAdapters,
      signal: runtime.signal,
      checkpointRun,
    });

    const finalized = await finalizePipelineToolRun({
      env: runtime.env,
      pipeline: parsed,
      output,
      checkpointRun,
    });
    await maybeUpdateRun(
      runtime,
      checkpointRun,
      finalized.status === "ok" ? "succeeded" : "waiting",
      finalized.output,
    );
    return okEnvelope(
      finalized.status,
      finalized.output,
      finalized.requiresApproval,
      finalized.requiresInput,
      checkpointRun,
    );
  } catch (err: any) {
    await maybeUpdateRun(runtime, checkpointRun, "failed");
    return errorEnvelope("runtime_error", err?.message ?? String(err));
  }
}

export async function resumeToolRequest({
  token,
  approvalId,
  approved,
  response,
  cancel,
  ctx = {},
}: {
  token?: string;
  approvalId?: string;
  approved?: boolean;
  response?: unknown;
  cancel?: boolean;
  ctx?: ToolRunContext;
}): Promise<ToolEnvelope> {
  const runtime = createToolContext(ctx);
  let payload: any;
  let resolvedApprovalId = approvalId ?? null;

  try {
    // Resolve short approval ID to token if provided
    let resolvedToken: string;
    if (approvalId) {
      const stateKey = await findStateKeyByApprovalId({ env: runtime.env, approvalId });
      if (!stateKey) {
        return errorEnvelope("parse_error", `Approval ID "${approvalId}" not found or expired`);
      }
      const kind = kindFromStateKey(stateKey);
      resolvedToken = encodeToken({
        protocolVersion: 1,
        v: 1,
        kind,
        stateKey,
      });
    } else if (token) {
      resolvedToken = token;
    } else {
      return errorEnvelope("parse_error", "resume requires token or approvalId");
    }
    payload = decodeResumeToken(resolvedToken);
  } catch (err: any) {
    return errorEnvelope("parse_error", err?.message ?? String(err));
  }

  // Helper: clean up approval ID index after successful use
  const cleanupIndex = async () => {
    if (resolvedApprovalId) {
      await deleteApprovalId({ env: runtime.env, approvalId: resolvedApprovalId });
    } else if (payload?.stateKey) {
      await cleanupApprovalIndexByStateKey({ env: runtime.env, stateKey: payload.stateKey });
    }
  };

  if (cancel === true) {
    await cleanupIndex();
    await resolveApprovalRecord({
      env: runtime.env,
      approvalId: resolvedApprovalId,
      stateKey: payload?.stateKey,
      status: "cancelled",
      decision: "cancelled",
    });
    if (payload.kind === "workflow-file" && payload.stateKey) {
      await deleteStateJson({ env: runtime.env, key: payload.stateKey });
    }
    if (payload.kind === "pipeline-resume" && payload.stateKey) {
      await deleteStateJson({ env: runtime.env, key: payload.stateKey });
    }
    return okEnvelope("cancelled", [], null, null);
  }

  if (payload.kind === "workflow-file") {
    try {
      const loadedRun = payload.stateKey
        ? await loadWorkflowRunContext(runtime.env, payload.stateKey)
        : undefined;
      const output = await runWorkflowFile({
        filePath: payload.filePath,
        ctx: { ...runtime, checkpointRun: loadedRun },
        resume: payload,
        approved,
        response,
        cancel,
      });

      if (output.status === "needs_approval") {
        // Don't clean up index — next gate will issue a new approvalId
        await maybeUpdateRun(runtime, loadedRun, "waiting");
        return okEnvelope("needs_approval", [], output.requiresApproval ?? null, null, loadedRun);
      }
      if (output.status === "needs_input") {
        await maybeUpdateRun(runtime, loadedRun, "waiting");
        return okEnvelope("needs_input", [], null, output.requiresInput ?? null, loadedRun);
      }
      await cleanupIndex();
      await resolveApprovalRecord({
        env: runtime.env,
        approvalId: resolvedApprovalId,
        stateKey: payload.stateKey,
        status:
          approved === false
            ? "rejected"
            : output.status === "cancelled"
              ? "cancelled"
              : "approved",
        decision:
          approved === false ? "reject" : output.status === "cancelled" ? "cancelled" : "approve",
        approvedBy: String(runtime.env.LOBSTER_APPROVAL_APPROVED_BY ?? "").trim() || null,
      });
      if (output.status === "cancelled") {
        await maybeUpdateRun(runtime, loadedRun, "cancelled");
        return okEnvelope("cancelled", [], null, null, loadedRun);
      }
      await maybeUpdateRun(runtime, loadedRun, "succeeded", output.output);
      return okEnvelope("ok", output.output, null, null, loadedRun);
    } catch (err: any) {
      if (err instanceof WorkflowResumeArgumentError) {
        return errorEnvelope("parse_error", err.message);
      }
      // Don't clean up index on error — allow retry by --id
      return errorEnvelope("runtime_error", err?.message ?? String(err));
    }
  }

  let resumeState;
  try {
    resumeState = await loadPipelineResumeState(runtime.env, payload.stateKey);
  } catch (err: any) {
    return errorEnvelope("runtime_error", err?.message ?? String(err));
  }
  const pipelineCheckpointRun = resumeState.runId
    ? createCheckpointRun(resumeState.runId, {
        jobId: resumeState.jobId,
        rootRunId: resumeState.rootRunId,
        parentRunId: resumeState.parentRunId,
        stepPathPrefix: resumeState.stepPathPrefix,
        depth: resumeState.depth,
      })
    : undefined;

  if (resumeState.haltType === "input_request") {
    if (approved !== undefined) {
      return errorEnvelope("parse_error", "pipeline input resumes require response");
    }
    if (response === undefined) {
      return errorEnvelope("parse_error", "pipeline input resumes require response");
    }
    try {
      validatePipelineInputResponse(resumeState.inputSchema, response);
    } catch (err: any) {
      return errorEnvelope("parse_error", err?.message ?? String(err));
    }
  } else {
    if (response !== undefined) {
      return errorEnvelope(
        "parse_error",
        "approval resumes require approved=true|false, not response",
      );
    }
    if (approved !== true) {
      await cleanupIndex();
      await deleteStateJson({ env: runtime.env, key: payload.stateKey });
      await resolveApprovalRecord({
        env: runtime.env,
        approvalId: resolvedApprovalId,
        stateKey: payload.stateKey,
        status: "rejected",
        decision: "reject",
      });
      await maybeUpdateRun(runtime, pipelineCheckpointRun, "cancelled");
      return okEnvelope("cancelled", [], null, null, pipelineCheckpointRun);
    }
  }

  const isSameStageInput =
    resumeState.haltType === "input_request" && resumeState.resumeMode === "same_stage";
  const remaining = resumeState.pipeline.slice(resumeState.resumeAtIndex);
  const input = isSameStageInput
    ? resumeState.items
    : resumeState.haltType === "input_request"
      ? [response]
      : resumeState.items;
  const requestInputResume = isSameStageInput
    ? {
        state: resumeState.commandInput!,
        response,
        onConsumed: async () => {
          await cleanupIndex();
          await deleteStateJson({ env: runtime.env, key: payload.stateKey });
        },
      }
    : undefined;

  try {
    const output = await runPipeline({
      pipeline: remaining,
      registry: runtime.registry,
      stdin: runtime.stdin,
      stdout: runtime.stdout,
      stderr: runtime.stderr,
      env: runtime.env,
      mode: "tool",
      cwd: runtime.cwd,
      llmAdapters: runtime.llmAdapters,
      signal: runtime.signal,
      input,
      requestInputResume,
      checkpointRun: pipelineCheckpointRun,
    });

    await cleanupIndex();
    await resolveApprovalRecord({
      env: runtime.env,
      approvalId: resolvedApprovalId,
      stateKey: payload.stateKey,
      status: approved === true ? "approved" : "cancelled",
      decision: approved === true ? "approve" : response !== undefined ? "response" : null,
      approvedBy: String(runtime.env.LOBSTER_APPROVAL_APPROVED_BY ?? "").trim() || null,
    });
    const finalized = await finalizePipelineToolRun({
      env: runtime.env,
      pipeline: remaining,
      output,
      previousStateKey: payload.stateKey,
      checkpointRun: pipelineCheckpointRun,
    });
    await maybeUpdateRun(
      runtime,
      pipelineCheckpointRun,
      finalized.status === "ok" ? "succeeded" : "waiting",
      finalized.output,
    );
    return okEnvelope(
      finalized.status,
      finalized.output,
      finalized.requiresApproval,
      finalized.requiresInput,
      pipelineCheckpointRun,
    );
  } catch (err: any) {
    // Don't clean up index on error — allow retry by --id
    return errorEnvelope("runtime_error", err?.message ?? String(err));
  }
}

export function createToolContext(ctx: ToolRunContext = {}) {
  return {
    cwd: ctx.cwd ?? process.cwd(),
    env: { ...process.env, ...ctx.env },
    mode: "tool" as const,
    stdin: ctx.stdin ?? process.stdin,
    stdout: ctx.stdout ?? createCaptureStream(),
    stderr: ctx.stderr ?? createCaptureStream(),
    signal: ctx.signal,
    registry: ctx.registry ?? createDefaultRegistry(),
    llmAdapters: ctx.llmAdapters,
  };
}

export function createCaptureStream() {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

function okEnvelope(
  status: "ok" | "needs_approval" | "needs_input" | "cancelled",
  output: unknown[],
  requiresApproval: ToolEnvelope["requiresApproval"],
  requiresInput: ToolEnvelope["requiresInput"],
  checkpointRun?: WorkflowExecutionContext,
) {
  return {
    protocolVersion: 1 as const,
    ok: true,
    status,
    output,
    ...(checkpointRun
      ? {
          jobId: checkpointRun.jobId,
          runId: checkpointRun.runId,
          rootRunId: checkpointRun.rootRunId,
          parentRunId: checkpointRun.parentRunId ?? null,
          latestCheckpointId: checkpointRun.latestCheckpointId ?? null,
        }
      : null),
    requiresApproval,
    requiresInput,
  };
}

function errorEnvelope(type: string, message: string): ToolEnvelope {
  return {
    protocolVersion: 1,
    ok: false,
    error: { type, message },
  };
}

async function resolveWorkflowFile(candidate: string, cwd: string) {
  const { stat } = await import("node:fs/promises");
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
  const fileStat = await stat(resolved);
  if (!fileStat.isFile()) throw new Error("Workflow path is not a file");
  const ext = path.extname(resolved).toLowerCase();
  if (![".lobster", ".yaml", ".yml", ".json"].includes(ext)) {
    throw new Error("Workflow file must end in .lobster, .yaml, .yml, or .json");
  }
  return resolved;
}

export async function getJob(params: { jobId: string; ctx?: ToolRunContext }) {
  const runtime = createToolContext(params.ctx);
  return getStoredJob(runtime.env, params.jobId);
}

export async function getRun(params: { runId: string; ctx?: ToolRunContext }) {
  const runtime = createToolContext(params.ctx);
  return getStoredRun(runtime.env, params.runId);
}

export async function listJobs(params: {
  status?: "running" | "waiting" | "succeeded" | "failed" | "cancelled";
  limit?: number;
  cursor?: string | null;
  ctx?: ToolRunContext;
}) {
  const runtime = createToolContext(params.ctx);
  return listStoredJobs({
    env: runtime.env,
    status: params.status,
    limit: params.limit,
    cursor: params.cursor,
  });
}

export async function listJobRuns(params: { jobId: string; ctx?: ToolRunContext }) {
  const runtime = createToolContext(params.ctx);
  return listStoredJobRuns({ env: runtime.env, jobId: params.jobId });
}

export async function listPendingApprovals(params: {
  jobId?: string | null;
  runId?: string | null;
  limit?: number;
  cursor?: string | null;
  ctx?: ToolRunContext;
}) {
  const runtime = createToolContext(params.ctx);
  return listStoredPendingApprovals({
    env: runtime.env,
    jobId: params.jobId,
    runId: params.runId,
    limit: params.limit,
    cursor: params.cursor,
  });
}

export async function listRunCheckpoints(params: { runId: string; ctx?: ToolRunContext }) {
  const runtime = createToolContext(params.ctx);
  return listStoredRunCheckpoints({ env: runtime.env, runId: params.runId });
}

export async function listJobCheckpoints(params: { jobId: string; ctx?: ToolRunContext }) {
  const runtime = createToolContext(params.ctx);
  return listStoredJobCheckpoints({ env: runtime.env, jobId: params.jobId });
}

export async function getCheckpointIO(params: { checkpointId: string; ctx?: ToolRunContext }) {
  const runtime = createToolContext(params.ctx);
  return getStoredCheckpointIO({ env: runtime.env, checkpointId: params.checkpointId });
}

export async function getCheckpoint(params: { checkpointId: string; ctx?: ToolRunContext }) {
  const runtime = createToolContext(params.ctx);
  return getStoredCheckpoint({ env: runtime.env, checkpointId: params.checkpointId });
}

export async function rerunToolRequest({
  jobId,
  argsPatch,
  inputOverride,
  ctx = {},
}: {
  jobId: string;
  argsPatch?: Record<string, unknown>;
  inputOverride?: unknown;
  ctx?: ToolRunContext;
}) {
  void inputOverride;
  const runtime = createToolContext(ctx);
  const job = await getStoredJob(runtime.env, jobId);
  if (!job?.rootRunId) return errorEnvelope("not_found", `Job "${jobId}" not found`);
  const run = await getStoredRun(runtime.env, job.rootRunId);
  if (!run) return errorEnvelope("not_found", `Root run for job "${jobId}" not found`);
  const args = mergePatch(run.args, argsPatch);
  if (run.sourceType === "workflow_file" && run.workflowFile) {
    return runToolRequest({
      filePath: run.workflowFile,
      args,
      ctx,
      lineage: { rerunOfJobId: job.jobId },
    });
  }
  if (run.sourceType === "pipeline" && run.pipelineText) {
    return runToolRequest({
      pipeline: run.pipelineText,
      args,
      ctx,
      lineage: { rerunOfJobId: job.jobId },
    });
  }
  return errorEnvelope(
    "replay_not_supported",
    "Run does not contain replayable workflow or pipeline source",
  );
}

export async function rewindToolRequest({
  jobId,
  checkpointId,
  argsPatch,
  inputOverride,
  envPatch,
  ctx = {},
}: {
  jobId: string;
  checkpointId: string;
  argsPatch?: Record<string, unknown>;
  inputOverride?: unknown;
  envPatch?: Record<string, string | undefined>;
  ctx?: ToolRunContext;
}) {
  void inputOverride;
  const runtime = createToolContext({ ...ctx, env: { ...ctx.env, ...envPatch } });
  const job = await getStoredJob(runtime.env, jobId);
  if (!job?.rootRunId) return errorEnvelope("not_found", `Job "${jobId}" not found`);
  const run = await getStoredRun(runtime.env, job.rootRunId);
  if (!run) return errorEnvelope("not_found", `Root run for job "${jobId}" not found`);
  const checkpoint = await getStoredCheckpoint({ env: runtime.env, checkpointId });
  if (!checkpoint || checkpoint.jobId !== jobId) {
    return errorEnvelope("not_found", `Checkpoint "${checkpointId}" not found for job "${jobId}"`);
  }
  const targetRun =
    checkpoint.runId === run.runId ? run : await getStoredRun(runtime.env, checkpoint.runId);
  if (!targetRun) {
    return errorEnvelope("not_found", `Run "${checkpoint.runId}" not found for checkpoint`);
  }
  if (targetRun.sourceType !== "workflow_file" || !targetRun.workflowFile) {
    return errorEnvelope("replay_not_supported", "V1 rewind supports workflow-file runs only");
  }
  const metadata = checkpoint.metadata as any;
  if (!metadata?.resultsSnapshot || typeof checkpoint.stepIndex !== "number") {
    return errorEnvelope(
      "replay_not_supported",
      "Checkpoint does not contain workflow replay state",
    );
  }
  const checkpointRun = await createRun({
    env: runtime.env,
    sourceType: "workflow_file",
    workflowFile: targetRun.workflowFile,
    args: mergePatch(targetRun.args, argsPatch),
    rewindOfJobId: job.jobId,
    rewindOfCheckpointId: checkpoint.checkpointId,
  });
  try {
    const output = await runWorkflowFile({
      filePath: targetRun.workflowFile,
      ctx: { ...runtime, checkpointRun },
      resume: {
        protocolVersion: 1,
        v: 1,
        kind: "workflow-file",
        filePath: targetRun.workflowFile,
        resumeAtIndex:
          checkpoint.status === "succeeded" || checkpoint.status === "skipped"
            ? checkpoint.stepIndex + 1
            : checkpoint.stepIndex,
        steps: metadata.resultsSnapshot,
        args: mergePatch(targetRun.args, argsPatch),
      },
    });
    if (output.status === "needs_approval") {
      await maybeUpdateRun(runtime, checkpointRun, "waiting");
      return okEnvelope("needs_approval", [], output.requiresApproval ?? null, null, checkpointRun);
    }
    if (output.status === "needs_input") {
      await maybeUpdateRun(runtime, checkpointRun, "waiting");
      return okEnvelope("needs_input", [], null, output.requiresInput ?? null, checkpointRun);
    }
    if (output.status === "cancelled") {
      await maybeUpdateRun(runtime, checkpointRun, "cancelled");
      return okEnvelope("cancelled", [], null, null, checkpointRun);
    }
    await maybeUpdateRun(runtime, checkpointRun, "succeeded", output.output);
    return okEnvelope("ok", output.output, null, null, checkpointRun);
  } catch (err: any) {
    await maybeUpdateRun(runtime, checkpointRun, "failed");
    return errorEnvelope("runtime_error", err?.message ?? String(err));
  }
}

async function maybeCreateRun(params: {
  runtime: ReturnType<typeof createToolContext>;
  sourceType: "workflow_file" | "pipeline";
  workflowFile?: string;
  pipelineText?: string;
  args?: unknown;
  lineage?: {
    parentRunId?: string | null;
    rerunOfJobId?: string | null;
    rewindOfJobId?: string | null;
    rewindOfCheckpointId?: string | null;
  };
}) {
  const hasLineage = Boolean(
    params.lineage?.parentRunId ||
    params.lineage?.rerunOfJobId ||
    params.lineage?.rewindOfJobId ||
    params.lineage?.rewindOfCheckpointId,
  );
  if (!checkpointsEnabled(params.runtime.env) && !hasLineage) return undefined;
  return createRun({
    env: params.runtime.env,
    sourceType: params.sourceType,
    workflowFile: params.workflowFile,
    pipelineText: params.pipelineText,
    args: params.args,
    rerunOfJobId: params.lineage?.rerunOfJobId,
    rewindOfJobId: params.lineage?.rewindOfJobId,
    rewindOfCheckpointId: params.lineage?.rewindOfCheckpointId,
  });
}

async function maybeUpdateRun(
  runtime: ReturnType<typeof createToolContext>,
  checkpointRun: WorkflowExecutionContext | undefined,
  status: "running" | "waiting" | "succeeded" | "failed" | "cancelled",
  finalOutput?: unknown,
) {
  if (!checkpointRun) return;
  await updateRun({
    env: runtime.env,
    runId: checkpointRun.runId,
    status,
    latestCheckpointId: checkpointRun.latestCheckpointId ?? null,
    finalOutput,
  });
}

async function loadWorkflowRunContext(
  env: Record<string, string | undefined>,
  stateKey: string,
): Promise<WorkflowExecutionContext | undefined> {
  const { readStateJson } = await import("../state/store.js");
  const stored = await readStateJson({ env, key: stateKey }).catch(() => null);
  const runId = typeof stored?.runId === "string" ? stored.runId : null;
  return runId
    ? createCheckpointRun(runId, {
        jobId: typeof stored?.jobId === "string" ? stored.jobId : runId,
        rootRunId: typeof stored?.rootRunId === "string" ? stored.rootRunId : runId,
        parentRunId: typeof stored?.parentRunId === "string" ? stored.parentRunId : null,
        stepPathPrefix: typeof stored?.stepPathPrefix === "string" ? stored.stepPathPrefix : "root",
        depth: typeof stored?.depth === "number" ? stored.depth : 0,
      })
    : undefined;
}

function mergePatch(base: unknown, patch: Record<string, unknown> | undefined) {
  const baseObj = base && typeof base === "object" && !Array.isArray(base) ? base : {};
  return { ...(baseObj as Record<string, unknown>), ...patch };
}
