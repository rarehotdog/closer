// Trimmed copy of closer shared/ledger.ts at dba9ff3 (github.com/rarehotdog/closer): only what photo -> cards needs.
export type CallSource = 'live' | 'cached' | 'mock';

export type CallRow = {
  callId: string;
  operationId: string | null;
  workspaceId: string | null;
  sessionId: string | null;
  model: string;
  http: number;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number } | null;
  costMicroUsd: number;
  estLiveCostMicroUsd: number;
  source: CallSource;
  createdAt: string;
};
