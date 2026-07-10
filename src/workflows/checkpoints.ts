export type RunStatus =
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  // A prior run attempt that was replaced by a rewind. Distinct from "cancelled"
  // (a real user cancel): steps that succeeded before the rewind point keep their
  // "succeeded" checkpoints and remain queryable.
  | "superseded";

export type JobWaitKind = "none" | "pause" | "approval" | "input";

export type JobWaitSnapshot = {
  kind: JobWaitKind;
  checkpointId?: string | null;
  stepId?: string | null;
  name?: string | null;
  approvalId?: string | null;
  nextStepId?: string | null;
  reason?: "pause_requested" | "step_mode" | null;
};

export type JobRecord = {
  jobId: string;
  rootRunId?: string | null;
  status: RunStatus;
  sourceType: "workflow_file" | "pipeline";
  parentJobId?: string | null;
  rootJobId?: string | null;
  latestRunId?: string | null;
  finalOutput?: unknown;
  finalOutputBlobId?: string | null;
  latestCheckpointId?: string | null;
  externalProvider?: string | null;
  externalAgentId?: string | null;
  externalSessionId?: string | null;
  externalSessionKey?: string | null;
  agent?: string | null;
  model?: string | null;
  title?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
  workflowFile?: string | null;
  workflowName?: string | null;
  workflowDescription?: string | null;
  pipelineText?: string | null;
  control: RunControlSnapshot;
  wait?: JobWaitSnapshot | null;
  createdAt: string;
  updatedAt: string;
};

export type RunControlState = "none" | "pause" | "cancel";

export type RunControlSnapshot = {
  stepMode: boolean;
  desired: RunControlState;
  updatedAt?: string | null;
};

export type RunControlRecord = {
  runId: string;
  jobId: string;
  desired: RunControlState;
  stepMode: boolean;
  updatedAt: string;
};

export type RunRecord = {
  jobId: string;
  runId: string;
  rootRunId: string;
  parentRunId?: string | null;
  parentStepId?: string | null;
  parentStepPath?: string | null;
  rewindOfCheckpointId?: string | null;
  status: RunStatus;
  sourceType: "workflow_file" | "pipeline";
  workflowFile?: string | null;
  workflowName?: string | null;
  workflowDescription?: string | null;
  pipelineText?: string | null;
  args?: unknown;
  depth: number;
  finalOutput?: unknown;
  finalOutputBlobId?: string | null;
  latestCheckpointId?: string | null;
  control: RunControlSnapshot;
  createdAt: string;
  updatedAt: string;
};

export type CheckpointStatus =
  | "started"
  | "waiting"
  | "resumed"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped";

/**
 * Structural classification of a checkpoint, orthogonal to `name` (the row's own
 * descriptor) and `status` (the lifecycle state). Governs visibility and
 * rewindability:
 * - `step`   the terminal outcome of a workflow step (succeeded/failed/skipped).
 *            The rewindable boundary and the primary user-visible row.
 * - `gate`   a suspension of a step (approval/input/pause). Also a rewindable
 *            boundary; renders as the step's waiting state.
 * - `detail` a sub-operation attributed to its owning step (auto-metadata, and
 *            pipeline stages nested inside a workflow step). Hidden by default;
 *            never an independent rewind target.
 * - `internal` engine bookkeeping (run start/end bookends, pipeline output
 *            envelope, cancel sentinel, resumed markers). Hidden; not rewindable.
 */
export type CheckpointKind = "step" | "gate" | "detail" | "internal";

/**
 * A checkpoint carries two orthogonal descriptors:
 * - `kind`: the structural role above.
 * - `name`: the row's own short descriptor, non-redundant with `kind` and the
 *   owning step's type. By kind: `step` -> the step execution kind
 *   (shell/pipeline/workflow/parallel/for_each/none/input); `gate` -> the gate
 *   flavor (approval/input/pause); `detail` -> the sub-op name (a pipeline stage
 *   command name, or `metadata`); `internal` -> output/start/end/resumed/cancel.
 *
 * `stepPath`/`stepId`/`stepIndex` identify the OWNING step and are IDENTICAL on
 * the boundary and every detail/internal child of that step. Run-scoped bookends
 * (`start`/`end`) belong to no step, so those three are null.
 */
export type CheckpointRecord = {
  checkpointId: string;
  seq: number;
  jobId: string;
  runId: string;
  rootRunId: string;
  parentRunId?: string | null;
  stepId?: string | null;
  stepPath?: string | null;
  stepIndex?: number | null;
  kind: CheckpointKind;
  name: string;
  status: CheckpointStatus;
  startedAt?: string | null;
  finishedAt?: string | null;
  metadata?: unknown;
  resumeState?: unknown;
  error?: unknown;
  exitStatus?: number | null;
  createdAt: string;
};

/**
 * A workflow step folded from its append-only checkpoint rows. One `StepRecord`
 * per `stepPath` within a run: the step's boundary (terminal outcome or active
 * gate) plus any attached detail sub-operations. This is the first-class unit
 * for rendering and for rewind targeting. `name` is the step execution kind
 * (from the boundary), `gate.name` the active gate flavor.
 */
export type StepRecord = {
  runId: string;
  jobId: string;
  stepId: string;
  stepPath: string;
  stepIndex: number | null;
  name?: string | null;
  status: CheckpointStatus;
  startedAt?: string | null;
  finishedAt?: string | null;
  gate?: {
    checkpointId: string;
    name?: string | null;
  } | null;
  error?: unknown;
  stepResult?: unknown;
  boundaryCheckpointId: string;
  detailCheckpointIds: string[];
};

export type CheckpointIORecord = {
  checkpointId?: string;
  stdin?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  jsonInput?: unknown;
  jsonOutput?: unknown;
};

export type ApprovalStatus = "waiting" | "approved" | "rejected" | "cancelled" | "expired";

export type ApprovalRecord = {
  approvalId: string;
  jobId?: string | null;
  runId?: string | null;
  rootRunId?: string | null;
  parentRunId?: string | null;
  checkpointId?: string | null;
  stepPath?: string | null;
  status: ApprovalStatus;
  prompt?: string | null;
  metadata?: unknown;
  decision?: string | null;
  initiatedBy?: string | null;
  requiredApprover?: string | null;
  approvedBy?: string | null;
  createdAt: string;
  resolvedAt?: string | null;
};

export type BlobRecord = {
  blobId: string;
  sha256: string;
  byteLength: number;
  contentType: string;
  storagePath: string;
  createdAt: string;
};

export type CacheEntry = {
  namespace: string;
  cacheKey: string;
  items: unknown[];
  input?: unknown;
  provider?: string | null;
  model?: string | null;
  tool?: string | null;
  action?: string | null;
  schemaHash?: string | null;
  status?: string | null;
  expiresAt?: string | null;
};

export type CacheEntryRecord = {
  namespace: string;
  cacheKey: string;
  items: unknown[];
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  expiresAt?: string | null;
  hitCount: number;
};

/**
 * Run-lifecycle hooks fired synchronously during a tool run so an embedder can
 * react before/while steps execute (rather than only after the run returns).
 * `onJobCreated` fires once the durable job/run exists but before any step runs.
 * `onCheckpoint` fires after each checkpoint is durably appended.
 */
export type ToolRunObserver = {
  onJobCreated?: (info: {
    jobId: string;
    runId: string;
    rootRunId: string;
    sourceType: "workflow_file" | "pipeline";
    isRewind?: boolean;
    parentJobId?: string | null;
    rootJobId?: string | null;
  }) => void | Promise<void>;
  onCheckpoint?: (checkpoint: CheckpointRecord) => void | Promise<void>;
};

export type WorkflowExecutionContext = {
  jobId: string;
  runId: string;
  rootRunId: string;
  parentRunId?: string | null;
  parentStepId?: string | null;
  parentStepPath?: string | null;
  stepPathPrefix: string;
  depth: number;
  latestCheckpointId?: string | null;
  observer?: ToolRunObserver;
  /**
   * Present when this context executes the sub-operations (pipeline stages,
   * output envelope) of an enclosing workflow step. Every checkpoint appended
   * here is a `detail`/`internal` of that step and inherits its owning identity.
   * Absent for a top-level pipeline, where each stage owns itself.
   */
  ownerStep?: { stepPath: string; stepId: string; stepIndex: number | null } | null;
};
