/** Provider-neutral conversation shape. Each provider adapter converts to and from its own wire format. */
export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface Msg {
  role: 'user' | 'assistant';
  content: Block[];
  /** The provider's own assistant content, replayed unchanged on the next request (thinking blocks etc.). */
  raw?: unknown;
}

export interface ToolDef { name: string; description: string; input_schema: Record<string, unknown> }

export interface LlmRequest {
  model: string;
  system: string;
  messages: Msg[];
  tools: ToolDef[];
  maxTokens?: number;
}

export interface LlmResponse {
  content: Block[];
  raw?: unknown;
  stop: 'end' | 'tool_use' | 'max_tokens' | 'refusal';
  usage: { in: number; out: number };
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export const textOf = (blocks: Block[]) =>
  blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim();
