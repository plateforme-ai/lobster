import { encodeToken } from "./token.js";
import { generateApprovalId } from "./store/helpers.js";
import { compileCached } from "./validation.js";
import { validateCommandInputState, type CommandInputState } from "./input_request.js";
import type { WorkflowExecutionContext } from "./workflows/checkpoints.js";
import {
  appendCheckpoint,
  createApprovalRecord,
  getCheckpoint,
  updateCheckpointStatus,
} from "./store/runtime_store.js";

export type PipelineResumeState = {
  kind: "pipeline-resume";
  jobId?: string;
  runId?: string;
  rootRunId?: string;
  parentRunId?: string | null;
  stepPathPrefix?: string;
  depth?: number;
  pipeline: Array<{ name: string; args: Record<string, unknown>; raw: string }>;
  resumeAtIndex: number;
  items: unknown[];
  haltType?: "approval_request" | "input_request";
  resumeMode?: "next_stage" | "same_stage";
  inputSchema?: unknown;
  prompt?: string;
  commandInput?: CommandInputState;
  createdAt: string;
};

export type PipelineApprovalRequest = {
  type: "approval_request";
  prompt: string;
  items: unknown[];
  preview?: string;
};

export type PipelineInputRequest = {
  type: "input_request";
  prompt: string;
  responseSchema: unknown;
  defaults?: unknown;
  subject?: unknown;
  items?: unknown[];
  commandInput?: CommandInputState;
};

export type PipelineRunOutput = {
  items: unknown[];
  halted?: boolean;
  haltedAt?: { index: number } | null;
};

export type PipelineToolRunResolution =
  | {
      status: "needs_approval";
      output: [];
      requiresApproval: {
        type: "approval_request";
        prompt: string;
        items: unknown[];
        preview?: string;
        resumeToken: string;
        approvalId?: string;
      };
      requiresInput: null;
    }
  | {
      status: "needs_input";
      output: [];
      requiresApproval: null;
      requiresInput: {
        type: "input_request";
        prompt: string;
        responseSchema: unknown;
        defaults?: unknown;
        subject?: unknown;
        resumeToken: string;
      };
    }
  | {
      status: "ok";
      output: unknown[];
      requiresApproval: null;
      requiresInput: null;
    };

export function extractPipelineHalt(output: { halted?: boolean; items: unknown[] }) {
  const halted =
    output.halted && output.items.length === 1
      ? (output.items[0] as Record<string, unknown>)
      : null;
  const approval =
    halted?.type === "approval_request" ? (halted as unknown as PipelineApprovalRequest) : null;
  const inputRequest =
    halted?.type === "input_request" ? (halted as unknown as PipelineInputRequest) : null;
  return { approval, inputRequest };
}

export async function finalizePipelineToolRun(params: {
  env: Record<string, string | undefined>;
  pipeline: PipelineResumeState["pipeline"];
  output: PipelineRunOutput;
  previousCheckpointId?: string;
  checkpointRun?: WorkflowExecutionContext;
}): Promise<PipelineToolRunResolution> {
  const { approval, inputRequest } = extractPipelineHalt(params.output);
  if (approval) {
    const resumeState: PipelineResumeState = {
      kind: "pipeline-resume",
      pipeline: params.pipeline,
      jobId: params.checkpointRun?.jobId,
      runId: params.checkpointRun?.runId,
      rootRunId: params.checkpointRun?.rootRunId,
      parentRunId: params.checkpointRun?.parentRunId,
      stepPathPrefix: params.checkpointRun?.stepPathPrefix,
      depth: params.checkpointRun?.depth,
      resumeAtIndex: (params.output.haltedAt?.index ?? -1) + 1,
      items: approval.items,
      haltType: "approval_request",
      prompt: approval.prompt,
      createdAt: new Date().toISOString(),
    };
    const approvalId = generateApprovalId();
    const checkpointId = await appendPipelineWaitCheckpoint(params.env, {
      run: params.checkpointRun,
      stepType: "approval",
      resumeState,
      metadata: { approvalId, prompt: approval.prompt },
    });
    if (checkpointId) {
      await createApprovalRecord({
        env: params.env,
        approvalId,
        run: params.checkpointRun,
        checkpointId,
        prompt: approval.prompt,
        metadata: approval,
      });
    }
    const resumeToken = encodeToken({
      protocolVersion: 1,
      v: 1,
      kind: "pipeline-resume",
      checkpointId,
      ...(params.checkpointRun?.jobId ? { jobId: params.checkpointRun.jobId } : null),
    });
    return {
      status: "needs_approval",
      output: [],
      requiresApproval: {
        ...approval,
        resumeToken,
        ...(checkpointId ? { approvalId } : null),
      },
      requiresInput: null,
    };
  }

  if (inputRequest) {
    const resumeMode = inputRequest.commandInput ? "same_stage" : "next_stage";
    const resumeState: PipelineResumeState = {
      kind: "pipeline-resume",
      pipeline: params.pipeline,
      jobId: params.checkpointRun?.jobId,
      runId: params.checkpointRun?.runId,
      rootRunId: params.checkpointRun?.rootRunId,
      parentRunId: params.checkpointRun?.parentRunId,
      stepPathPrefix: params.checkpointRun?.stepPathPrefix,
      depth: params.checkpointRun?.depth,
      resumeAtIndex:
        resumeMode === "same_stage"
          ? (params.output.haltedAt?.index ?? -1)
          : (params.output.haltedAt?.index ?? -1) + 1,
      items: resumeMode === "same_stage" ? (inputRequest.items ?? []) : [],
      haltType: "input_request",
      resumeMode,
      inputSchema: inputRequest.responseSchema,
      prompt: inputRequest.prompt,
      ...(inputRequest.commandInput ? { commandInput: inputRequest.commandInput } : null),
      createdAt: new Date().toISOString(),
    };
    const checkpointId = await appendPipelineWaitCheckpoint(params.env, {
      run: params.checkpointRun,
      stepType: "pipeline_input",
      resumeState,
      metadata: { prompt: inputRequest.prompt },
    });
    const resumeToken = encodeToken({
      protocolVersion: 1,
      v: 1,
      kind: "pipeline-resume",
      checkpointId,
      ...(params.checkpointRun?.jobId ? { jobId: params.checkpointRun.jobId } : null),
    });
    return {
      status: "needs_input",
      output: [],
      requiresApproval: null,
      requiresInput: {
        type: "input_request",
        prompt: inputRequest.prompt,
        responseSchema: inputRequest.responseSchema,
        ...(inputRequest.defaults !== undefined ? { defaults: inputRequest.defaults } : null),
        ...(inputRequest.subject !== undefined ? { subject: inputRequest.subject } : null),
        resumeToken,
      },
    };
  }

  if (params.previousCheckpointId) {
    await updateCheckpointStatus({
      env: params.env,
      checkpointId: params.previousCheckpointId,
      status: "resumed",
    });
  }
  return {
    status: "ok",
    output: params.output.items,
    requiresApproval: null,
    requiresInput: null,
  };
}

/**
 * Persist pipeline resume state on a fresh waiting checkpoint and return its id.
 * Replaces the former JSON state-file dual-store: the checkpoint's
 * `resume_state_json` is the single source of truth, and appending it auto-
 * supersedes any prior waiting gate on the same run.
 */
async function appendPipelineWaitCheckpoint(
  env: Record<string, string | undefined>,
  args: {
    run?: WorkflowExecutionContext;
    stepType: "approval" | "pipeline_input";
    resumeState: PipelineResumeState;
    metadata?: unknown;
  },
): Promise<string | null> {
  return appendCheckpoint({
    env,
    run: args.run,
    stepId: args.stepType === "approval" ? "pipeline-approval" : "pipeline-input",
    stepType: args.stepType,
    status: "waiting",
    metadata: args.metadata,
    resumeState: args.resumeState,
  });
}

export async function loadPipelineResumeState(
  env: Record<string, string | undefined>,
  checkpointId: string,
) {
  const checkpoint = await getCheckpoint({ env, checkpointId });
  const stored = checkpoint?.resumeState;
  // Only a still-waiting gate is resumable. Once consumed (status flipped to
  // "resumed") or superseded, the resume state is spent — re-resuming must fail
  // rather than replay the run.
  if (!stored || typeof stored !== "object" || checkpoint?.status !== "waiting") {
    throw new Error("Pipeline resume state not found");
  }
  const data = stored as Partial<PipelineResumeState>;
  if (!Array.isArray(data.pipeline)) throw new Error("Invalid pipeline resume state");
  validatePipelineShape(data.pipeline);
  if (
    typeof data.resumeAtIndex !== "number" ||
    !Number.isInteger(data.resumeAtIndex) ||
    data.resumeAtIndex < 0 ||
    data.resumeAtIndex > data.pipeline.length
  ) {
    throw new Error("Invalid pipeline resume state");
  }
  if (!Array.isArray(data.items)) throw new Error("Invalid pipeline resume state");
  if (
    data.haltType !== undefined &&
    !["approval_request", "input_request"].includes(data.haltType)
  ) {
    throw new Error("Invalid pipeline resume state");
  }
  if (data.resumeMode !== undefined && !["next_stage", "same_stage"].includes(data.resumeMode)) {
    throw new Error("Invalid pipeline resume state");
  }
  if (data.haltType === "input_request") {
    if (data.inputSchema === undefined || typeof data.prompt !== "string") {
      throw new Error("Invalid pipeline resume state");
    }
    if (data.resumeMode === "same_stage") {
      if (data.resumeAtIndex >= data.pipeline.length) {
        throw new Error("Invalid pipeline resume state");
      }
      data.commandInput = validateCommandInputState(data.commandInput);
    } else if (data.commandInput !== undefined) {
      throw new Error("Invalid pipeline resume state");
    }
  } else if (data.resumeMode === "same_stage" || data.commandInput !== undefined) {
    throw new Error("Invalid pipeline resume state");
  }
  return data as PipelineResumeState;
}

export function validatePipelineInputResponse(schema: unknown, response: unknown) {
  if (schema === undefined) {
    throw new Error("pipeline input response schema is missing");
  }
  let validator;
  try {
    validator = compileCached(schema as any);
  } catch {
    throw new Error("pipeline input response schema is invalid");
  }
  const ok = validator(response);
  if (ok) return;
  const first = validator.errors?.[0];
  const pathValue = first?.instancePath || "/";
  const reason = first?.message ? ` ${first.message}` : "";
  throw new Error(`pipeline input response failed schema validation at ${pathValue}:${reason}`);
}

function validatePipelineShape(pipeline: unknown[]) {
  for (const stage of pipeline) {
    if (!stage || typeof stage !== "object") throw new Error("Invalid pipeline resume state");
    const data = stage as Record<string, unknown>;
    if (typeof data.name !== "string" || data.name.length === 0) {
      throw new Error("Invalid pipeline resume state");
    }
    if (!data.args || typeof data.args !== "object" || Array.isArray(data.args)) {
      throw new Error("Invalid pipeline resume state");
    }
    if (typeof data.raw !== "string") throw new Error("Invalid pipeline resume state");
  }
}
