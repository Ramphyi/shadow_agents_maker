import type { Block, LlmClient, LlmRequest, LlmResponse } from './types.ts';
import { newId, safeJson } from '../util.ts';

interface OaToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
interface OaMessage { role: string; content: string | null; tool_calls?: OaToolCall[]; tool_call_id?: string }

/**
 * Any server that speaks the OpenAI Chat Completions format: OpenAI, xAI (Grok), Ollama, LM Studio,
 * OpenRouter, llama.cpp, vLLM. This is the path for local models.
 */
export function openaiClient(baseUrl: string, apiKey: string | undefined): LlmClient {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  return {
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const messages: OaMessage[] = [{ role: 'system', content: req.system }];
      for (const m of req.messages) {
        if (m.role === 'assistant') {
          const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
          const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => ({
            id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input) },
          }));
          messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
          continue;
        }
        for (const b of m.content) {
          if (b.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content });
          else if (b.type === 'text') messages.push({ role: 'user', content: b.text });
        }
      }

      const body = {
        model: req.model,
        messages,
        ...(req.tools.length
          ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) }
          : {}),
      };

      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(300_000),
        });
      } catch (e) {
        throw new Error(`Could not reach the AI provider at ${baseUrl} (${e instanceof Error ? e.message : e}).`);
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`AI provider returned ${res.status}: ${text.slice(0, 400)}`);
      const data = safeJson<{ choices?: { message: OaMessage; finish_reason: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }>(text, {});
      const choice = data.choices?.[0];
      if (!choice) throw new Error(`AI provider returned no choices: ${text.slice(0, 300)}`);

      const content: Block[] = [];
      if (choice.message.content) content.push({ type: 'text', text: choice.message.content });
      for (const call of choice.message.tool_calls ?? []) {
        content.push({
          type: 'tool_use',
          id: call.id || newId('call'),
          name: call.function.name,
          input: safeJson<Record<string, unknown>>(call.function.arguments, {}),
        });
      }
      const hasCalls = content.some((b) => b.type === 'tool_use');
      return {
        content,
        stop: hasCalls ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end',
        usage: { in: data.usage?.prompt_tokens ?? 0, out: data.usage?.completion_tokens ?? 0 },
      };
    },
  };
}
