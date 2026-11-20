import type { SpriteId } from './sprites/models';

export type Mode = 'allow' | 'ask' | 'deny';
export type Risk = 'safe' | 'read' | 'act';
export type LiveState = 'idle' | 'working' | 'waiting' | 'error';

export interface Fn {
  id: string; agentId: string; name: string; kind: 'schedule' | 'webhook' | 'manual'; cron: string | null;
  prompt: string; enabled: boolean; lastRun: number | null; nextRun: number | null; hookUrl: string | null;
}
export interface Grant { agentId: string; tool: string; mode: Mode; updatedAt: number; updatedBy: string }
export interface Run {
  id: string; agentId: string; functionId: string | null; trigger: string; input: string;
  status: 'running' | 'completed' | 'failed'; output: string | null; error: string | null;
  startedAt: number; endedAt: number | null; steps: number; tokensIn: number; tokensOut: number;
}
export interface Agent {
  id: string; name: string; slug: string; sprite: SpriteId; color: string; role: string; instructions: string;
  providerId: string | null; model: string | null; status: 'active' | 'paused'; a2a: boolean;
  createdAt: number; createdBy: string; state: LiveState; functions: Fn[]; grants: Grant[]; lastRun: Run | null;
}
export interface Tool {
  name: string; kind: 'builtin' | 'http' | 'js'; description: string; inputSchema: JsonSchema; risk: Risk;
  reviewed: boolean; needs: string[]; missing: string[]; config: Record<string, unknown> | null; createdBy: string;
}
export interface JsonSchema { type?: string; properties?: Record<string, { type?: string; description?: string; enum?: string[] }>; required?: string[] }
export interface Approval {
  id: string; agentId: string | null; runId: string | null; actor: string; tool: string; args: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'expired'; createdAt: number; resolvedAt: number | null; resolvedBy: string | null;
}
export interface Note { id: string; agentId: string | null; title: string; body: string; level: 'info' | 'success' | 'warning' | 'urgent'; read: boolean; ts: number }
export interface Provider { id: string; name: string; kind: 'anthropic' | 'openai'; baseUrl: string | null; model: string; hasKey: boolean }
export interface AuditEntry {
  id: number; ts: number; actorType: string; actorId: string; action: string; target: string; decision: string;
  detail: Record<string, unknown>; runId: string | null; agentId: string | null; ms: number | null;
}
export interface ChatMessage { id: number; agentId: string; role: 'user' | 'assistant'; content: string; ts: number }
export interface FnSpec { name: string; kind: Fn['kind']; cron: string | null; prompt: string }
export interface AgentSpec {
  name: string; sprite: SpriteId; color: string; role: string; instructions: string;
  functions: FnSpec[]; tools: (string | { name: string; mode: Mode })[]; a2a?: boolean;
}
export interface Template extends AgentSpec { id: string; tagline: string }
export interface Snapshot {
  agents: Agent[]; tools: Tool[]; approvals: Approval[]; notifications: Note[]; providers: Provider[];
  defaultProvider: string | null; secrets: { name: string; updatedAt: number }[];
  settings: { notifyUrl: string; approvalMinutes: number }; sprites: SpriteId[]; colors: string[]; templates: Template[];
}
export interface ConnectInfo { url: string; mcpUrl: string; mcpToken: string; a2aToken: string; a2aAgents: { name: string; url: string; card: string }[] }

declare global {
  interface Window { shadow?: { connection: () => Promise<{ url: string; token: string; home: string }>; platform: string } }
}
