import { Writable } from "node:stream";
import path from "node:path";

import { createDefaultRegistry } from "../commands/registry.js";
import { parsePipeline } from "../parser.js";
import { decodeResumeToken } from "../resume.js";
import { runPipeline } from "../runtime.js";
import { encodeToken } from "../token.js";
import {
  WorkflowResumeArgumentError,
  continueParentChain,
  readWorkflowDescription,
  readWorkflowDisplayName,
  runWorkflowFile,
} from "../workflows/file.js";
import {
  finalizePipelineToolRun,
  loadPipelineResumeState,
  validatePipelineInputResponse,
} from "../pipeline_resume_state.js";
import {
  cancelSupersededRuns,
  createCheckpointRun,
  createRewindRun,
  createRun,
  findCheckpointIdByApprovalId,
  findHeadResumeCheckpoint,
  foldRunResults,
  resetJobControlDesired,
  getCheckpoint as getStoredCheckpoint,
  getJob as getStoredJob,
  getRun as getStoredRun,
  listJobCheckpoints as listStoredJobCheckpoints,
  listJobRuns as listStoredJobRuns,
  listJobs as listStoredJobs,
  listPendingApprovals as listStoredPendingApprovals,
  listRunCheckpoints as listStoredRunCheckpoints,
  listRunSteps as listStoredRunSteps,
  listJobStepsAllRuns as listStoredJobStepsAllRuns,
  getCheckpointIO as getStoredCheckpointIO,
  resolveApprovalRecord,
  resolveJobHeadWait,
  recordTerminalCancel,
  setJobExternalSession as setStoredJobExternalSession,
  setRunControl,
  updateCheckpointStatus,
  updateRun,
} from "../store/runtime_store.js";
import type {
  CheckpointRecord,
  JobRecord,
  RunRecord,
  ToolRunObserver,
  WorkflowExecutionContext,
} from "../workflows/checkpoints.js";
import type { LlmTextCompleter } from "../commands/stdlib/llm_client.js";

export type { ToolRunObserver } from "../workflows/checkpoints.js";

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
  llmText?: LlmTextCompleter;
  observer?: ToolRunObserver;
};

type PausedInfo = {
  stepId: string;
  stepIndex: number;
  nextStepId?: string | null;
  resumeToken: string;
  reason: "pause_requested" | "step_mode";
};

export type ToolEnvelope = {
  protocolVersion: 1;
  ok: boolean;
  status?: "ok" | "needs_approval" | "needs_input" | "cancelled" | "paused";
  output?: unknown[];
  jobId?: string;
  runId?: string;
  rootRunId?: string;
  parentRunId?: string | null;
  checkpointId?: string | null;
  latestCheckpointId?: string | null;
  externalProvider?: string | null;
  externalAgentId?: string | null;
  externalSessionId?: string | null;
  externalSessionKey?: string | null;
  paused?: PausedInfo | null;
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
  stepMode,
  agent,
  model,
  title,
  description,
  metadata,
  ctx = {},
  lineage = {},
}: {
  pipeline?: string;
  filePath?: string;
  args?: Record<string, unknown>;
  stepMode?: boolean;
  agent?: string | null;
  model?: string | null;
  title?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
  ctx?: ToolRunContext;
  lineage?: {
    parentRunId?: string | null;
    parentJobId?: string | null;
    rootJobId?: string | null;
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

  let normalizedTitle: string | null;
  let normalizedDescription: string | null;
  let normalizedMetadata: Record<string, unknown> | null;
  try {
    normalizedTitle = normalizeJobTextField(title, "title");
    normalizedDescription = normalizeJobTextField(description, "description");
    normalizedMetadata = normalizeJobMetadata(metadata);
  } catch (err: any) {
    return errorEnvelope("parse_error", err?.message ?? String(err));
  }

  if (hasFile) {
    let resolvedFilePath: string;
    try {
      resolvedFilePath = await resolveWorkflowFile(filePath!, runtime.cwd);
    } catch (err: any) {
      return errorEnvelope("parse_error", err?.message ?? String(err));
    }

    try {
      const workflowName = await readWorkflowDisplayName(resolvedFilePath);
      const workflowDescription = await readWorkflowDescription(resolvedFilePath);
      checkpointRun = await maybeCreateRun({
        runtime,
        sourceType: "workflow_file",
        workflowFile: resolvedFilePath,
        workflowName,
        workflowDescription,
        args,
        agent,
        model,
        title: normalizedTitle,
        description: normalizedDescription,
        metadata: normalizedMetadata,
        lineage,
      });
      await attachObserverAndAnnounce(runtime, checkpointRun, {
        sourceType: "workflow_file",
        lineage,
      });
      if (stepMode && checkpointRun?.runId) {
        await setRunControl({
          env: runtime.env,
          runId: checkpointRun.runId,
          jobId: checkpointRun.jobId,
          stepMode: true,
        });
      }
      const output = await runWorkflowFile({
        filePath: resolvedFilePath,
        args,
        ctx: { ...runtime, checkpointRun },
      });

      const sessionExtra = await sessionExtraForRun(runtime, checkpointRun);
      if (output.status === "needs_approval") {
        await maybeUpdateRun(runtime, checkpointRun, "waiting");
        return okEnvelope(
          "needs_approval",
          [],
          output.requiresApproval ?? null,
          null,
          checkpointRun,
          sessionExtra,
        );
      }
      if (output.status === "needs_input") {
        await maybeUpdateRun(runtime, checkpointRun, "waiting");
        return okEnvelope(
          "needs_input",
          [],
          null,
          output.requiresInput ?? null,
          checkpointRun,
          sessionExtra,
        );
      }
      if (output.status === "paused") {
        await maybeUpdateRun(runtime, checkpointRun, "waiting");
        return okEnvelope("paused", [], null, null, checkpointRun, {
          ...sessionExtra,
          ...pausedExtra(output),
        });
      }
      if (output.status === "cancelled") {
        await maybeUpdateRun(runtime, checkpointRun, "cancelled");
        return okEnvelope("cancelled", [], null, null, checkpointRun, sessionExtra);
      }
      await maybeUpdateRun(runtime, checkpointRun, "succeeded", output.output);
      return okEnvelope("ok", output.output, null, null, checkpointRun, sessionExtra);
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
      workflowDescription: null,
      args,
      agent,
      model,
      title: normalizedTitle,
      description: normalizedDescription,
      metadata: normalizedMetadata,
      lineage,
    });
    await attachObserverAndAnnounce(runtime, checkpointRun, {
      sourceType: "pipeline",
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
      llmText: runtime.llmText,
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
    const sessionExtra = await sessionExtraForRun(runtime, checkpointRun);
    return okEnvelope(
      finalized.status,
      finalized.output,
      finalized.requiresApproval,
      finalized.requiresInput,
      checkpointRun,
      sessionExtra,
    );
  } catch (err: any) {
    await maybeUpdateRun(runtime, checkpointRun, "failed");
    return errorEnvelope("runtime_error", err?.message ?? String(err));
  }
}

export async function resumeToolRequest({
  token,
  approvalId,
  jobId,
  runId,
  approved,
  response,
  argsPatch,
  approvedPayloadOverride,
  ctx = {},
}: {
  token?: string;
  approvalId?: string;
  jobId?: string;
  runId?: string;
  approved?: boolean;
  response?: unknown;
  argsPatch?: Record<string, unknown>;
  approvedPayloadOverride?: unknown;
  ctx?: ToolRunContext;
}): Promise<ToolEnvelope> {
  const runtime = createToolContext(ctx);
  let payload: any;
  let resolvedApprovalId = approvalId ?? null;

  try {
    // Resolve short approval ID / job / run to the waiting checkpoint token.
    let resolvedToken: string;
    if (approvalId) {
      const checkpointId = await findCheckpointIdByApprovalId({ env: runtime.env, approvalId });
      if (!checkpointId) {
        return errorEnvelope("parse_error", `Approval ID "${approvalId}" not found or expired`);
      }
      resolvedToken = await encodeCheckpointResumeToken(runtime.env, checkpointId);
    } else if (token) {
      resolvedToken = token;
    } else if (jobId || runId) {
      const isContinueIntent = approved === undefined && response === undefined;
      const head = await findHeadResumeCheckpoint({
        env: runtime.env,
        jobId,
        runId,
        allowedGateNames: isContinueIntent ? ["pause"] : undefined,
      });
      if (!head) {
        const wait = isContinueIntent
          ? await resolveJobHeadWait({ env: runtime.env, jobId, runId })
          : null;
        const subject = runId ? `run "${runId}"` : `job "${jobId}"`;
        const message =
          isContinueIntent && wait && wait.kind !== "pause"
            ? `Job is waiting on ${wait.kind}, not paused`
            : `No resumable (waiting/paused) state found for ${subject}`;
        return errorEnvelope("no_resumable_state", message);
      }
      resolvedToken = encodeToken({
        protocolVersion: 1,
        v: 1,
        kind: head.resumeKind,
        checkpointId: head.checkpointId,
        ...(jobId ? { jobId } : null),
      });
    } else {
      return errorEnvelope("parse_error", "resume requires token, approvalId, jobId, or runId");
    }
    payload = decodeResumeToken(resolvedToken);
  } catch (err: any) {
    return errorEnvelope("parse_error", err?.message ?? String(err));
  }

  if (payload.kind === "workflow-file") {
    try {
      const loadedRun = payload.checkpointId
        ? await loadWorkflowRunContext(runtime.env, payload.checkpointId)
        : undefined;
      attachObserver(runtime, loadedRun);
      const output = await runWorkflowFile({
        filePath: payload.filePath,
        ctx: { ...runtime, checkpointRun: loadedRun },
        resume: payload,
        approved,
        response,
        argsOverride: argsPatch,
        approvedPayloadOverride,
      });

      const sessionExtra = await sessionExtraForRun(runtime, loadedRun);
      if (output.status === "needs_approval") {
        // Don't clean up index — next gate will issue a new approvalId
        await maybeUpdateRun(runtime, loadedRun, "waiting");
        return okEnvelope(
          "needs_approval",
          [],
          output.requiresApproval ?? null,
          null,
          loadedRun,
          sessionExtra,
        );
      }
      if (output.status === "needs_input") {
        await maybeUpdateRun(runtime, loadedRun, "waiting");
        return okEnvelope(
          "needs_input",
          [],
          null,
          output.requiresInput ?? null,
          loadedRun,
          sessionExtra,
        );
      }
      if (output.status === "paused") {
        await maybeUpdateRun(runtime, loadedRun, "waiting");
        return okEnvelope("paused", [], null, null, loadedRun, {
          ...sessionExtra,
          ...pausedExtra(output),
        });
      }
      await resolveApprovalRecord({
        env: runtime.env,
        approvalId: resolvedApprovalId,
        checkpointId: payload.checkpointId,
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

      // Child-first nested resume: the resumed run is the child gate that
      // triggered the suspension. Once it reaches a terminal state, walk up the
      // parent chain (marking each workflow-call step done and continuing the
      // parent past it). The top-most result — a re-suspension at a deeper gate,
      // or the root run's terminal state — is what we surface.
      const resumedRun = loadedRun?.runId
        ? await getStoredRun(runtime.env, loadedRun.runId).catch(() => null)
        : null;
      if (resumedRun?.parentRunId) {
        const walk = await continueParentChain({
          ctx: { ...runtime, checkpointRun: loadedRun },
          childRunId: loadedRun!.runId,
          childStatus: output.status === "cancelled" ? "cancelled" : "ok",
          childOutput: output.output,
        });
        const topRun = await loadWorkflowRunHead(runtime.env, walk.topRunId);
        const topSessionExtra = await sessionExtraForRun(runtime, topRun ?? loadedRun);
        const walkResult = walk.result;
        if (walkResult.status === "needs_approval") {
          return okEnvelope(
            "needs_approval",
            [],
            walkResult.requiresApproval ?? null,
            null,
            topRun ?? loadedRun,
            topSessionExtra,
          );
        }
        if (walkResult.status === "needs_input") {
          return okEnvelope(
            "needs_input",
            [],
            null,
            walkResult.requiresInput ?? null,
            topRun ?? loadedRun,
            topSessionExtra,
          );
        }
        if (walkResult.status === "paused") {
          return okEnvelope("paused", [], null, null, topRun ?? loadedRun, {
            ...topSessionExtra,
            ...pausedExtra(walkResult),
          });
        }
        if (walkResult.status === "cancelled") {
          return okEnvelope("cancelled", [], null, null, topRun ?? loadedRun, topSessionExtra);
        }
        return okEnvelope(
          "ok",
          walkResult.output,
          null,
          null,
          topRun ?? loadedRun,
          topSessionExtra,
        );
      }

      if (output.status === "cancelled") {
        await maybeUpdateRun(runtime, loadedRun, "cancelled");
        return okEnvelope("cancelled", [], null, null, loadedRun, sessionExtra);
      }
      await maybeUpdateRun(runtime, loadedRun, "succeeded", output.output);
      return okEnvelope("ok", output.output, null, null, loadedRun, sessionExtra);
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
    resumeState = await loadPipelineResumeState(runtime.env, payload.checkpointId);
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
  attachObserver(runtime, pipelineCheckpointRun);

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
      await resolveApprovalRecord({
        env: runtime.env,
        approvalId: resolvedApprovalId,
        checkpointId: payload.checkpointId,
        status: "rejected",
        decision: "reject",
        approvedBy: String(runtime.env.LOBSTER_APPROVAL_APPROVED_BY ?? "").trim() || null,
      });
      if (payload.checkpointId) {
        await updateCheckpointStatus({
          env: runtime.env,
          checkpointId: payload.checkpointId,
          status: "resumed",
        });
      }
      if (pipelineCheckpointRun?.runId) {
        await recordTerminalCancel({
          env: runtime.env,
          run: pipelineCheckpointRun,
          runId: pipelineCheckpointRun.runId,
          jobId: pipelineCheckpointRun.jobId,
          metadata: { reason: "approval_rejected" },
        });
      }
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
          if (payload.checkpointId) {
            await updateCheckpointStatus({
              env: runtime.env,
              checkpointId: payload.checkpointId,
              status: "resumed",
            });
          }
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
      llmText: runtime.llmText,
      signal: runtime.signal,
      input,
      requestInputResume,
      checkpointRun: pipelineCheckpointRun,
    });

    await resolveApprovalRecord({
      env: runtime.env,
      approvalId: resolvedApprovalId,
      checkpointId: payload.checkpointId,
      status: approved === true ? "approved" : "cancelled",
      decision: approved === true ? "approve" : response !== undefined ? "response" : null,
      approvedBy: String(runtime.env.LOBSTER_APPROVAL_APPROVED_BY ?? "").trim() || null,
    });
    const finalized = await finalizePipelineToolRun({
      env: runtime.env,
      pipeline: remaining,
      output,
      previousCheckpointId: payload.checkpointId,
      checkpointRun: pipelineCheckpointRun,
    });
    await maybeUpdateRun(
      runtime,
      pipelineCheckpointRun,
      finalized.status === "ok" ? "succeeded" : "waiting",
      finalized.output,
    );
    const sessionExtra = await sessionExtraForRun(runtime, pipelineCheckpointRun);
    return okEnvelope(
      finalized.status,
      finalized.output,
      finalized.requiresApproval,
      finalized.requiresInput,
      pipelineCheckpointRun,
      sessionExtra,
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
    llmText: ctx.llmText,
    observer: ctx.observer,
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
  status: "ok" | "needs_approval" | "needs_input" | "cancelled" | "paused",
  output: unknown[],
  requiresApproval: ToolEnvelope["requiresApproval"],
  requiresInput: ToolEnvelope["requiresInput"],
  checkpointRun?: WorkflowExecutionContext,
  extra?: {
    paused?: PausedInfo | null;
    externalProvider?: string | null;
    externalAgentId?: string | null;
    externalSessionId?: string | null;
    externalSessionKey?: string | null;
  },
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
    ...(extra?.externalProvider !== undefined
      ? { externalProvider: extra.externalProvider }
      : null),
    ...(extra?.externalAgentId !== undefined ? { externalAgentId: extra.externalAgentId } : null),
    ...(extra?.externalSessionId !== undefined
      ? { externalSessionId: extra.externalSessionId }
      : null),
    ...(extra?.externalSessionKey !== undefined
      ? { externalSessionKey: extra.externalSessionKey }
      : null),
    ...(extra?.paused !== undefined ? { paused: extra.paused } : null),
    requiresApproval,
    requiresInput,
  };
}

async function sessionExtraForRun(
  runtime: ReturnType<typeof createToolContext>,
  checkpointRun: WorkflowExecutionContext | undefined,
): Promise<{
  externalProvider?: string | null;
  externalAgentId?: string | null;
  externalSessionId?: string | null;
  externalSessionKey?: string | null;
}> {
  if (!checkpointRun?.jobId) return {};
  const job = await getStoredJob(runtime.env, checkpointRun.jobId).catch(() => null);
  if (!job) return {};
  return {
    externalProvider: job.externalProvider ?? null,
    externalAgentId: job.externalAgentId ?? null,
    externalSessionId: job.externalSessionId ?? null,
    externalSessionKey: job.externalSessionKey ?? null,
  };
}

function pausedExtra(output: { paused?: PausedInfo }): { paused: PausedInfo | null } {
  return { paused: output.paused ?? null };
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
  status?: "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "superseded";
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

export async function listRunSteps(params: { runId: string; ctx?: ToolRunContext }) {
  const runtime = createToolContext(params.ctx);
  return listStoredRunSteps({ env: runtime.env, runId: params.runId });
}

/**
 * First-class steps for a job. Defaults to the job's latest run so the caller
 * sees the current attempt's steps (a rewind creates a new run); pass an explicit
 * `runId` to inspect a specific attempt. Pass `allRuns: true` for the full,
 * collision-safe lineage across every run (folded per run) — required whenever a
 * rewind has spread the job's current logical workflow across the origin
 * (surviving prefix) and rewind (replayed suffix) runs.
 */
export async function listJobSteps(params: {
  jobId: string;
  runId?: string;
  allRuns?: boolean;
  ctx?: ToolRunContext;
}) {
  const runtime = createToolContext(params.ctx);
  if (params.allRuns) {
    return listStoredJobStepsAllRuns({ env: runtime.env, jobId: params.jobId });
  }
  let runId = params.runId ?? null;
  if (!runId) {
    const job = await getStoredJob(runtime.env, params.jobId);
    runId = job?.latestRunId ?? job?.rootRunId ?? null;
  }
  if (!runId) return [];
  return listStoredRunSteps({ env: runtime.env, runId });
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
  // rerun starts from index 0 with no checkpoint snapshot, so per-step input
  // overrides do not apply; edit `argsPatch` (workflow args) instead, or use
  // rewind with `inputOverride` to edit a specific step's prior output.
  if (inputOverride !== undefined) {
    return errorEnvelope(
      "invalid_input_override",
      "inputOverride is not supported for rerun; use argsPatch or rewind with inputOverride",
    );
  }
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
      agent: job.agent ?? null,
      model: job.model ?? null,
      title: job.title ?? null,
      description: job.description ?? null,
      metadata: job.metadata ?? null,
      ctx,
      lineage: { parentJobId: job.jobId, rootJobId: job.rootJobId ?? job.jobId },
    });
  }
  if (run.sourceType === "pipeline" && run.pipelineText) {
    return runToolRequest({
      pipeline: run.pipelineText,
      args,
      agent: job.agent ?? null,
      model: job.model ?? null,
      title: job.title ?? null,
      description: job.description ?? null,
      metadata: job.metadata ?? null,
      ctx,
      lineage: { parentJobId: job.jobId, rootJobId: job.rootJobId ?? job.jobId },
    });
  }
  return errorEnvelope(
    "replay_not_supported",
    "Run does not contain replayable workflow or pipeline source",
  );
}

/**
 * A rewind target that has passed all validation: a `step`/`gate` boundary
 * checkpoint on a replayable workflow-file run, with a concrete step index.
 */
type ResolvedRewindTarget = {
  checkpoint: CheckpointRecord & { stepIndex: number };
  targetRun: RunRecord & { workflowFile: string };
};

/**
 * Resolve a rewind request to the concrete step-boundary checkpoint it targets
 * and validate that it is rewindable. `stepPath` targets the step's boundary
 * checkpoint on the job's latest run — the ergonomic form, since a step (not a
 * raw checkpoint) is the rewindable unit; `checkpointId` targets that checkpoint
 * directly. Exactly one must be provided. Only `step`/`gate` checkpoints on a
 * workflow-file run with a concrete step index are rewindable.
 */
async function resolveRewindTarget(params: {
  env: Record<string, string | undefined>;
  jobId: string;
  job: JobRecord;
  run: RunRecord;
  checkpointId?: string;
  stepPath?: string;
}): Promise<ResolvedRewindTarget | { error: ToolEnvelope }> {
  const { env, jobId, job, run } = params;
  let resolvedCheckpointId = params.checkpointId ?? null;
  if (!resolvedCheckpointId && params.stepPath) {
    const runId = job.latestRunId ?? job.rootRunId!;
    const steps = await listStoredRunSteps({ env, runId });
    const step = steps.find((s) => s.stepPath === params.stepPath);
    if (!step) {
      return {
        error: errorEnvelope("not_found", `Step "${params.stepPath}" not found for job "${jobId}"`),
      };
    }
    resolvedCheckpointId = step.boundaryCheckpointId;
  }
  if (!resolvedCheckpointId) {
    return {
      error: errorEnvelope("invalid_request", "rewind requires either checkpointId or stepPath"),
    };
  }

  const checkpoint = await getStoredCheckpoint({ env, checkpointId: resolvedCheckpointId });
  if (!checkpoint || checkpoint.jobId !== jobId) {
    return {
      error: errorEnvelope(
        "not_found",
        `Checkpoint "${resolvedCheckpointId}" not found for job "${jobId}"`,
      ),
    };
  }
  // Only a step boundary (a step outcome or an active gate) is rewindable;
  // `detail`/`internal` checkpoints are not independent targets.
  if (checkpoint.kind !== "step" && checkpoint.kind !== "gate") {
    return {
      error: errorEnvelope(
        "rewind_target_not_a_step",
        `Checkpoint "${resolvedCheckpointId}" has kind "${checkpoint.kind}" and is not a rewindable step boundary`,
      ),
    };
  }
  const targetRun =
    checkpoint.runId === run.runId ? run : await getStoredRun(env, checkpoint.runId);
  if (!targetRun) {
    return {
      error: errorEnvelope("not_found", `Run "${checkpoint.runId}" not found for checkpoint`),
    };
  }
  if (targetRun.sourceType !== "workflow_file" || !targetRun.workflowFile) {
    return {
      error: errorEnvelope("replay_not_supported", "V1 rewind supports workflow-file runs only"),
    };
  }
  if (typeof checkpoint.stepIndex !== "number") {
    return {
      error: errorEnvelope(
        "replay_not_supported",
        "Checkpoint does not contain workflow replay state",
      ),
    };
  }
  return {
    checkpoint: checkpoint as CheckpointRecord & { stepIndex: number },
    targetRun: targetRun as RunRecord & { workflowFile: string },
  };
}

/**
 * Build the inline resume state for a rewind: replay the target step and every
 * step after it. The preserved prefix (steps strictly before the target) is
 * folded from the run's append-only log into the seed results map; the target
 * step's own prior result is deliberately excluded so it re-executes from
 * scratch. `inputOverride` may edit ONLY preserved prefix steps — the target and
 * downstream steps run fresh, so overriding them is meaningless and rejected.
 */
async function buildRewindReplayState(params: {
  env: Record<string, string | undefined>;
  jobId: string;
  runId: string;
  targetStepIndex: number;
  inputOverride?: Record<string, Record<string, unknown>>;
}): Promise<{ resumeAtIndex: number; steps: Record<string, any> } | { error: ToolEnvelope }> {
  let steps = await foldRunResults({
    env: params.env,
    runId: params.runId,
    beforeStepIndex: params.targetStepIndex,
  });

  if (params.inputOverride && Object.keys(params.inputOverride).length > 0) {
    steps = { ...steps };
    for (const [stepId, patch] of Object.entries(params.inputOverride)) {
      if (!(stepId in steps)) {
        return {
          error: errorEnvelope(
            "invalid_input_override",
            `Step "${stepId}" is not a preserved step before the rewind target for job "${params.jobId}"; only steps before the target can be overridden`,
          ),
        };
      }
      steps[stepId] = { ...steps[stepId], ...patch };
    }
  }

  // The target step re-executes, so replay starts AT its index regardless of its
  // prior status (succeeded, failed, skipped, or a waiting gate).
  return { resumeAtIndex: params.targetStepIndex, steps };
}

export async function rewindToolRequest({
  jobId,
  checkpointId,
  stepPath,
  argsPatch,
  inputOverride,
  envPatch,
  ctx = {},
}: {
  jobId: string;
  // Rewind target: either a raw `checkpointId` or a `stepPath` (resolved to that
  // step's boundary checkpoint). Exactly one is required. The target step and
  // every step after it re-execute; earlier steps are preserved.
  checkpointId?: string;
  stepPath?: string;
  argsPatch?: Record<string, unknown>;
  inputOverride?: Record<string, Record<string, unknown>>;
  envPatch?: Record<string, string | undefined>;
  ctx?: ToolRunContext;
}) {
  const runtime = createToolContext({ ...ctx, env: { ...ctx.env, ...envPatch } });
  const job = await getStoredJob(runtime.env, jobId);
  if (!job?.rootRunId) return errorEnvelope("not_found", `Job "${jobId}" not found`);
  const run = await getStoredRun(runtime.env, job.rootRunId);
  if (!run) return errorEnvelope("not_found", `Root run for job "${jobId}" not found`);

  const target = await resolveRewindTarget({
    env: runtime.env,
    jobId,
    job,
    run,
    ...(checkpointId ? { checkpointId } : {}),
    ...(stepPath ? { stepPath } : {}),
  });
  if ("error" in target) return target.error;
  const { checkpoint, targetRun } = target;

  const replay = await buildRewindReplayState({
    env: runtime.env,
    jobId,
    runId: checkpoint.runId,
    targetStepIndex: checkpoint.stepIndex,
    ...(inputOverride ? { inputOverride } : {}),
  });
  if ("error" in replay) return replay.error;

  const replayArgs = mergePatch(targetRun.args, argsPatch);
  // All validation above completes before any write, so a rejected rewind leaves
  // no run/checkpoint behind. Cancel the prior attempt's abandoned in-flight
  // run(s) + open gates, clear any stale control intent (job-wide, on the root
  // run), then insert a new top-level run under the SAME job.
  await cancelSupersededRuns({ env: runtime.env, jobId });
  await resetJobControlDesired({ env: runtime.env, jobId });
  const checkpointRun = await createRewindRun({
    env: runtime.env,
    job,
    targetRun,
    checkpointId: checkpoint.checkpointId,
    args: replayArgs,
  });
  await attachObserverAndAnnounce(runtime, checkpointRun, {
    sourceType: targetRun.sourceType,
    isRewind: true,
    lineage: { parentJobId: job.parentJobId ?? null, rootJobId: job.rootJobId ?? null },
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
        resumeAtIndex: replay.resumeAtIndex,
        steps: replay.steps,
        args: replayArgs,
      },
    });
    const sessionExtra = await sessionExtraForRun(runtime, checkpointRun);
    if (output.status === "needs_approval") {
      await maybeUpdateRun(runtime, checkpointRun, "waiting");
      return okEnvelope(
        "needs_approval",
        [],
        output.requiresApproval ?? null,
        null,
        checkpointRun,
        sessionExtra,
      );
    }
    if (output.status === "needs_input") {
      await maybeUpdateRun(runtime, checkpointRun, "waiting");
      return okEnvelope(
        "needs_input",
        [],
        null,
        output.requiresInput ?? null,
        checkpointRun,
        sessionExtra,
      );
    }
    if (output.status === "paused") {
      await maybeUpdateRun(runtime, checkpointRun, "waiting");
      return okEnvelope("paused", [], null, null, checkpointRun, {
        ...sessionExtra,
        ...pausedExtra(output),
      });
    }
    if (output.status === "cancelled") {
      await maybeUpdateRun(runtime, checkpointRun, "cancelled");
      return okEnvelope("cancelled", [], null, null, checkpointRun, sessionExtra);
    }
    await maybeUpdateRun(runtime, checkpointRun, "succeeded", output.output);
    return okEnvelope("ok", output.output, null, null, checkpointRun, sessionExtra);
  } catch (err: any) {
    await maybeUpdateRun(runtime, checkpointRun, "failed");
    return errorEnvelope("runtime_error", err?.message ?? String(err));
  }
}

async function resolveControlTarget(
  runtime: ReturnType<typeof createToolContext>,
  params: { jobId?: string | null; runId?: string | null },
): Promise<{ runId: string; jobId: string } | { error: ToolEnvelope }> {
  if (params.runId) {
    const run = await getStoredRun(runtime.env, params.runId);
    if (!run) {
      return { error: errorEnvelope("not_found", `Run "${params.runId}" not found`) };
    }
    return { runId: run.runId, jobId: run.jobId };
  }
  if (params.jobId) {
    const job = await getStoredJob(runtime.env, params.jobId);
    if (!job?.rootRunId) {
      return { error: errorEnvelope("not_found", `Job "${params.jobId}" not found`) };
    }
    return { runId: job.rootRunId, jobId: job.jobId };
  }
  return {
    error: errorEnvelope("parse_error", "pause/cancel/setStepMode requires jobId or runId"),
  };
}

export async function pauseRun(params: {
  jobId?: string | null;
  runId?: string | null;
  ctx?: ToolRunContext;
}): Promise<ToolEnvelope> {
  const runtime = createToolContext(params.ctx);
  const target = await resolveControlTarget(runtime, params);
  if ("error" in target) return target.error;

  // At a wait gate the run is already suspended — pause only applies to in-flight
  // runs. Queuing desired=pause here would surprise operators after approve/input.
  const job = await getStoredJob(runtime.env, target.jobId).catch(() => null);
  const wait = job?.status === "waiting" ? job.wait : null;
  if (wait && (wait.kind === "pause" || wait.kind === "approval" || wait.kind === "input")) {
    return errorEnvelope(
      "already_waiting",
      `Job is already waiting on ${wait.kind}`,
    );
  }

  await setRunControl({
    env: runtime.env,
    runId: target.runId,
    jobId: target.jobId,
    desired: "pause",
  });
  return {
    protocolVersion: 1,
    ok: true,
    status: "ok",
    output: [],
    jobId: target.jobId,
    runId: target.runId,
  };
}

export async function cancelRun(params: {
  jobId?: string | null;
  runId?: string | null;
  ctx?: ToolRunContext;
}): Promise<ToolEnvelope> {
  const runtime = createToolContext(params.ctx);
  const target = await resolveControlTarget(runtime, params);
  if ("error" in target) return target.error;

  // At a wait gate (pause/approval/input) the run is suspended, not mid-step:
  // cancel takes effect immediately, with a terminal checkpoint consumers can
  // observe. Mid-step runs stay cooperative (desired = "cancel", honored at the
  // next step boundary by the workflow loop).
  const job = await getStoredJob(runtime.env, target.jobId).catch(() => null);
  const wait = job?.status === "waiting" ? job.wait : null;
  if (wait && (wait.kind === "pause" || wait.kind === "approval" || wait.kind === "input")) {
    if (wait.kind === "approval") {
      await resolveApprovalRecord({
        env: runtime.env,
        approvalId: wait.approvalId,
        checkpointId: wait.checkpointId,
        status: "cancelled",
        decision: "cancelled",
      });
    }
    await recordTerminalCancel({
      env: runtime.env,
      runId: target.runId,
      jobId: target.jobId,
      stepId: wait.stepId ?? null,
      stepIndex: wait.stepIndex ?? null,
      metadata: { gate: wait.kind },
    });
    return {
      protocolVersion: 1,
      ok: true,
      status: "cancelled",
      output: [],
      jobId: target.jobId,
      runId: target.runId,
    };
  }

  await setRunControl({
    env: runtime.env,
    runId: target.runId,
    jobId: target.jobId,
    desired: "cancel",
  });
  return {
    protocolVersion: 1,
    ok: true,
    status: "ok",
    output: [],
    jobId: target.jobId,
    runId: target.runId,
  };
}

export async function setStepMode(params: {
  jobId?: string | null;
  runId?: string | null;
  stepMode: boolean;
  ctx?: ToolRunContext;
}): Promise<ToolEnvelope> {
  const runtime = createToolContext(params.ctx);
  const target = await resolveControlTarget(runtime, params);
  if ("error" in target) return target.error;
  await setRunControl({
    env: runtime.env,
    runId: target.runId,
    jobId: target.jobId,
    stepMode: params.stepMode,
  });
  return {
    protocolVersion: 1,
    ok: true,
    status: "ok",
    output: [],
    jobId: target.jobId,
    runId: target.runId,
  };
}

export async function setJobExternalSession(params: {
  jobId: string;
  sessionKey: string | null;
  provider?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  ctx?: ToolRunContext;
}): Promise<ToolEnvelope> {
  const runtime = createToolContext(params.ctx);
  const job = await getStoredJob(runtime.env, params.jobId);
  if (!job) return errorEnvelope("not_found", `Job "${params.jobId}" not found`);
  const provider = params.provider ?? "openclaw";
  await setStoredJobExternalSession({
    env: runtime.env,
    jobId: params.jobId,
    sessionKey: params.sessionKey,
    provider,
    agentId: params.agentId ?? null,
    sessionId: params.sessionId ?? null,
  });
  return {
    protocolVersion: 1,
    ok: true,
    status: "ok",
    output: [],
    jobId: params.jobId,
    externalProvider: provider,
    externalAgentId: params.agentId ?? null,
    externalSessionId: params.sessionId ?? null,
    externalSessionKey: params.sessionKey,
  };
}

async function maybeCreateRun(params: {
  runtime: ReturnType<typeof createToolContext>;
  sourceType: "workflow_file" | "pipeline";
  workflowFile?: string;
  workflowName?: string | null;
  workflowDescription?: string | null;
  pipelineText?: string;
  args?: unknown;
  agent?: string | null;
  model?: string | null;
  title?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
  lineage?: {
    parentRunId?: string | null;
    parentJobId?: string | null;
    rootJobId?: string | null;
  };
}) {
  return createRun({
    env: params.runtime.env,
    sourceType: params.sourceType,
    workflowFile: params.workflowFile,
    workflowName: params.workflowName,
    workflowDescription: params.workflowDescription,
    pipelineText: params.pipelineText,
    args: params.args,
    agent: params.agent,
    model: params.model,
    title: params.title,
    description: params.description,
    metadata: params.metadata,
    parentJobId: params.lineage?.parentJobId,
    rootJobId: params.lineage?.rootJobId,
  });
}

/**
 * Attach the run's observer onto an existing (resumed) execution context so
 * per-checkpoint callbacks fire during resume. No job-created announcement: the
 * job already exists and any external session is already bound.
 */
function attachObserver(
  runtime: ReturnType<typeof createToolContext>,
  checkpointRun: WorkflowExecutionContext | undefined,
): void {
  if (checkpointRun && runtime.observer) {
    checkpointRun.observer = runtime.observer;
  }
}

/**
 * Bind the observer to a freshly created run context and announce the job/run
 * BEFORE any step executes, so embedders can attach a session up front. Throws
 * from onJobCreated propagate to the caller's catch, aborting the run before
 * execution.
 */
async function attachObserverAndAnnounce(
  runtime: ReturnType<typeof createToolContext>,
  checkpointRun: WorkflowExecutionContext | undefined,
  opts: {
    sourceType: "workflow_file" | "pipeline";
    isRewind?: boolean;
    lineage?: {
      parentJobId?: string | null;
      rootJobId?: string | null;
    };
  },
): Promise<void> {
  if (!checkpointRun) return;
  attachObserver(runtime, checkpointRun);
  if (!checkpointRun.jobId) return;
  await runtime.observer?.onJobCreated?.({
    jobId: checkpointRun.jobId,
    runId: checkpointRun.runId,
    rootRunId: checkpointRun.rootRunId,
    sourceType: opts.sourceType,
    ...(opts.isRewind ? { isRewind: true } : {}),
    ...(opts.lineage?.parentJobId !== undefined ? { parentJobId: opts.lineage.parentJobId } : {}),
    ...(opts.lineage?.rootJobId !== undefined ? { rootJobId: opts.lineage.rootJobId } : {}),
  });
}

function normalizeJobTextField(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeJobMetadata(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("metadata must be a plain object");
  }
  assertJsonSerializable(value, "metadata", new WeakSet());
  return value as Record<string, unknown>;
}

function assertJsonSerializable(value: unknown, label: string, seen: WeakSet<object>) {
  if (value === null) return;
  const valueType = typeof value;
  if (valueType === "string" || valueType === "boolean") return;
  if (valueType === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error(`${label} must be JSON-serializable`);
    }
    return;
  }
  if (valueType !== "object") {
    throw new Error(`${label} must be JSON-serializable`);
  }
  const object = value as object;
  if (seen.has(object)) {
    throw new Error(`${label} must be JSON-serializable`);
  }
  seen.add(object);
  if (Array.isArray(value)) {
    for (const item of value) {
      assertJsonSerializable(item, label, seen);
    }
    return;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    assertJsonSerializable((value as Record<string, unknown>)[key], label, seen);
  }
}

async function maybeUpdateRun(
  runtime: ReturnType<typeof createToolContext>,
  checkpointRun: WorkflowExecutionContext | undefined,
  status: "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "superseded",
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
  checkpointId: string,
): Promise<WorkflowExecutionContext | undefined> {
  const checkpoint = await getStoredCheckpoint({ env, checkpointId }).catch(() => null);
  const runId = checkpoint?.runId ?? null;
  if (!runId) return undefined;
  const resume = (checkpoint?.resumeState ?? null) as {
    stepPathPrefix?: unknown;
    depth?: unknown;
  } | null;
  return createCheckpointRun(runId, {
    jobId: checkpoint?.jobId ?? runId,
    rootRunId: checkpoint?.rootRunId ?? runId,
    parentRunId: checkpoint?.parentRunId ?? null,
    stepPathPrefix: typeof resume?.stepPathPrefix === "string" ? resume.stepPathPrefix : "root",
    depth: typeof resume?.depth === "number" ? resume.depth : 0,
    latestCheckpointId: checkpointId,
  });
}

/**
 * Build a run execution context from a run id. Used after a nested parent
 * walk-up to anchor the resume envelope on the top-most (root) run rather than
 * the child gate that was originally resumed.
 */
async function loadWorkflowRunHead(
  env: Record<string, string | undefined>,
  runId: string,
): Promise<WorkflowExecutionContext | undefined> {
  const run = await getStoredRun(env, runId).catch(() => null);
  if (!run) return undefined;
  return createCheckpointRun(run.runId, {
    jobId: run.jobId,
    rootRunId: run.rootRunId,
    parentRunId: run.parentRunId ?? null,
    depth: run.depth,
    latestCheckpointId: run.latestCheckpointId ?? null,
  });
}

/**
 * Build a resume token from a waiting checkpoint id, deriving the resume kind
 * from the checkpoint's persisted resume state (the single source of truth).
 */
async function encodeCheckpointResumeToken(
  env: Record<string, string | undefined>,
  checkpointId: string,
): Promise<string> {
  const checkpoint = await getStoredCheckpoint({ env, checkpointId });
  const resume = (checkpoint?.resumeState ?? null) as { kind?: unknown } | null;
  const kind = resume?.kind === "pipeline-resume" ? "pipeline-resume" : "workflow-file";
  return encodeToken({
    protocolVersion: 1,
    v: 1,
    kind,
    checkpointId,
    ...(checkpoint?.jobId ? { jobId: checkpoint.jobId } : null),
  });
}

function mergePatch(base: unknown, patch: Record<string, unknown> | undefined) {
  const baseObj = base && typeof base === "object" && !Array.isArray(base) ? base : {};
  return { ...(baseObj as Record<string, unknown>), ...patch };
}
