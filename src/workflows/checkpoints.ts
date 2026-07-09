export type RunStatus = "running" | "waiting" | "succeeded" | "failed" | "cancelled";

export type JobWaitKind = "none" | "pause" | "approval" | "input";

export type JobWaitSnapshot = {
  kind: JobWaitKind;
  checkpointId?: string | null;
  stepId?: string | null;
  stepType?: string | null;
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
  stepType?: string | null;
  status: CheckpointStatus;
  startedAt?: string | null;
  finishedAt?: string | null;
  metadata?: unknown;
  resumeState?: unknown;
  error?: unknown;
  exitStatus?: number | null;
  createdAt: string;
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
};
