import { decodeToken, encodeToken } from "./token.js";
import { decodeWorkflowResumePayload } from "./workflows/file.js";
import { findCheckpointIdByApprovalId, getCheckpoint } from "./store/runtime_store.js";

export type PipelineResumePayload = {
  protocolVersion: 1;
  v: 1;
  kind: "pipeline-resume";
  checkpointId: string;
  jobId?: string;
};

export function parseResumeArgs(argv) {
  const args = { decision: null, token: null, approvalId: null, responseJson: null };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--token") {
      args.token = argv[i + 1];
      i++;
      continue;
    }
    if (tok.startsWith("--token=")) {
      args.token = tok.slice("--token=".length);
      continue;
    }
    if (tok === "--id") {
      args.approvalId = argv[i + 1];
      i++;
      continue;
    }
    if (tok.startsWith("--id=")) {
      args.approvalId = tok.slice("--id=".length);
      continue;
    }
    if (tok === "--response-json") {
      args.responseJson = argv[i + 1];
      i++;
      continue;
    }
    if (tok.startsWith("--response-json=")) {
      args.responseJson = tok.slice("--response-json=".length);
      continue;
    }
    if (tok === "--approve" || tok === "--decision") {
      args.decision = argv[i + 1];
      i++;
      continue;
    }
    if (tok.startsWith("--approve=")) {
      args.decision = tok.slice("--approve=".length);
      continue;
    }
    if (tok.startsWith("--decision=")) {
      args.decision = tok.slice("--decision=".length);
      continue;
    }
  }

  if (!args.token && !args.approvalId) throw new Error("resume requires --token or --id");
  const intentCount = Number(Boolean(args.decision)) + Number(args.responseJson !== null);
  if (intentCount > 1) {
    throw new Error("resume accepts only one of --approve or --response-json");
  }
  if (intentCount === 0) {
    throw new Error("resume requires --approve yes|no or --response-json");
  }

  if (args.responseJson !== null) {
    try {
      return {
        token: args.token ? String(args.token) : null,
        approvalId: args.approvalId ? String(args.approvalId) : null,
        response: JSON.parse(String(args.responseJson)),
      };
    } catch {
      throw new Error("resume --response-json must be valid JSON");
    }
  }

  const decision = String(args.decision).toLowerCase();
  if (!["yes", "y", "no", "n"].includes(decision))
    throw new Error("resume --approve must be yes or no");
  return {
    token: args.token ? String(args.token) : null,
    approvalId: args.approvalId ? String(args.approvalId) : null,
    approved: decision === "yes" || decision === "y",
  };
}

/**
 * Resolve an approval ID to a resume token by looking up the waiting checkpoint
 * it is anchored to. The checkpoint's step type determines the resume kind
 * (pipeline vs workflow-file).
 */
export async function resolveApprovalId(
  approvalId: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  const checkpointId = await findCheckpointIdByApprovalId({ env, approvalId });
  if (!checkpointId) {
    throw new Error(`Approval ID "${approvalId}" not found or expired`);
  }

  const checkpoint = await getCheckpoint({ env, checkpointId });
  if (!checkpoint) {
    throw new Error(`Approval ID "${approvalId}" not found or expired`);
  }

  const resume = (checkpoint.resumeState ?? null) as { kind?: unknown } | null;
  const kind = resume?.kind === "pipeline-resume" ? "pipeline-resume" : "workflow-file";

  return encodeToken({
    protocolVersion: 1,
    v: 1,
    kind,
    checkpointId,
    ...(checkpoint.jobId ? { jobId: checkpoint.jobId } : null),
  });
}

export function decodeResumeToken(token) {
  const payload = decodeToken(token);
  if (!payload || typeof payload !== "object") throw new Error("Invalid token");
  if (payload.protocolVersion !== 1) throw new Error("Unsupported protocol version");
  if (payload.v !== 1) throw new Error("Unsupported token version");
  const workflowPayload = decodeWorkflowResumePayload(payload);
  if (workflowPayload) return workflowPayload;
  const pipelinePayload = decodePipelineResumePayload(payload);
  if (pipelinePayload) return pipelinePayload;
  throw new Error("Invalid token");
}

function decodePipelineResumePayload(payload: unknown): PipelineResumePayload | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as Partial<PipelineResumePayload>;
  if (data.kind !== "pipeline-resume") return null;
  if (data.protocolVersion !== 1 || data.v !== 1) throw new Error("Unsupported token version");
  if (!data.checkpointId || typeof data.checkpointId !== "string") throw new Error("Invalid token");
  return {
    protocolVersion: 1,
    v: 1,
    kind: "pipeline-resume",
    checkpointId: data.checkpointId,
    ...(typeof data.jobId === "string" ? { jobId: data.jobId } : null),
  };
}
