import Anthropic from '@anthropic-ai/sdk';
import type { Block, LlmClient, LlmRequest, LlmResponse } from './types.ts';

/**
 * Models whose safety classifiers can decline a request. For these we opt into server-side fallbacks,
 * so a declined request is re-run on another model inside the same call instead of failing the run.
 */
const FALLBACK_MODELS = /^claude-(fable-5-[12]|opus-5-5|opus-5|sonnet-5-5)$/;

export function anthropicClient(apiKey: string | undefined, baseUrl?: string | null): LlmClient {
  // With no key the SDK resolves credentials from the environment (ANTHROPIC_API_KEY, auth token, profile).
  const client = new Anthropic({ ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseURL: baseUrl } : {}) });

  return {
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const messages = req.messages.map((m) =>
        m.role === 'assistant' && m.raw
          ? { role: 'assistant' as const, content: m.raw as Anthropic.ContentBlockParam[] }
          : { role: m.role, content: m.content as Anthropic.ContentBlockParam[] },
      );
      const tools: Anthropic.Tool[] = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool.InputSchema,
      }));
      const params = {
        model: req.model,
        max_tokens: req.maxTokens ?? 16000,
        system: req.system,
        messages,
        ...(tools.length ? { tools } : {}),
      };

      let res: Anthropic.Message;
      try {
        res = FALLBACK_MODELS.test(req.model)
          ? ((await client.beta.messages.create({
              ...(params as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming),
              betas: ['server-side-fallback-2026-07-01'],
              fallbacks: 'default',
            } as Anthropic.Beta.MessageCreateParamsNonStreaming)) as unknown as Anthropic.Message)
          : await client.messages.create(params);
      } catch (error) {
        if (error instanceof Anthropic.AuthenticationError) throw new Error('Anthropic rejected the API key. Check the provider in Settings.');
        if (error instanceof Anthropic.NotFoundError) throw new Error(`Anthropic does not know the model "${req.model}".`);
        if (error instanceof Anthropic.RateLimitError) throw new Error('Anthropic rate limit reached. The run will work again once the limit resets.');
        if (error instanceof Anthropic.APIError) throw new Error(`Anthropic API error ${error.status ?? ''}: ${error.message}`);
        throw error;
      }

      const content: Block[] = [];
      for (const block of res.content) {
        if (block.type === 'text') content.push({ type: 'text', text: block.text });
        else if (block.type === 'tool_use') content.push({ type: 'tool_use', id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
      }
      const stop: LlmResponse['stop'] =
        res.stop_reason === 'tool_use' ? 'tool_use'
          : res.stop_reason === 'max_tokens' ? 'max_tokens'
            : res.stop_reason === 'refusal' ? 'refusal' : 'end';
      return {
        content,
        raw: res.content,
        stop,
        usage: { in: res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0), out: res.usage.output_tokens },
      };
    },
  };
}
