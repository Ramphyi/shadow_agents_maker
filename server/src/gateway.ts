import type { Core } from './core.ts';
import type { Actor, Agent, Approval, Mode } from './store.ts';
import { errMsg, HttpError, truncate, validateArgs } from './util.ts';

export interface ToolCall {
  actor: Actor;
  /** The shadow whose grants apply. Null for a direct test by a person or harness. */
  agent: Agent | null;
  runId: string | null;
  tool: string;
  args: Record<string, unknown>;
  /** Overrides the grant lookup. Used for direct tests, which have no agent grant. */
  mode?: Mode;
  chain?: string[];
}
export interface ToolOutcome { ok: boolean; output: string; decision: string }

const EXEC_TIMEOUT_MS = 180_000;
const DEFAULT_APPROVAL_MINUTES = 60;

/**
 * Every tool call in the system goes through here: permission check, human approval when the grant
 * says "ask", execution with a timeout, secret redaction, and one audit entry per call.
 */
export class Gateway {
  private core: Core;
  private waiting = new Map<string, { settle: (approved: boolean) => void; timer: NodeJS.Timeout }>();

  constructor(core: Core) { this.core = core; }

  log(actor: Actor, action: string, target: string, decision: string, detail: Record<string, unknown> = {},
    extra: { runId?: string | null; agentId?: string | null; ms?: number | null } = {}) {
    const entry = this.core.store.addAudit({
      actorType: actor.type, actorId: actor.id, action, target, decision, detail,
      runId: extra.runId ?? null, agentId: extra.agentId ?? null, ms: extra.ms ?? null,
    });
    this.core.emit('audit', entry);
    return entry;
  }

  /** Arguments as they are stored in the audit log and shown in approval cards: redacted and bounded. */
  private safeArgs(args: Record<string, unknown>): Record<string, unknown> {
    const text = this.core.vault.redact(JSON.stringify(args ?? {}));
    if (text.length <= 4000) return JSON.parse(text);
    return { _truncated: truncate(text, 4000) };
  }

  /** The mode that applies to this call, before any approval. */
  effectiveMode(call: Pick<ToolCall, 'agent' | 'tool' | 'mode'>): Mode {
    const spec = this.core.tools.get(call.tool);
    let mode: Mode = call.mode ?? (call.agent ? this.core.store.grant(call.agent.id, call.tool)?.mode : undefined) ?? 'deny';
    // A custom tool nobody has reviewed yet never runs without a person looking at the call.
    if (spec && !spec.reviewed && mode === 'allow') mode = 'ask';
    return mode;
  }

  async call(call: ToolCall): Promise<ToolOutcome> {
    const { actor, agent, runId, tool } = call;
    const args = call.args ?? {};
    const audit = (decision: string, detail: Record<string, unknown>, ms?: number) =>
      this.log(actor, 'tool.call', tool, decision, { args: this.safeArgs(args), ...detail }, { runId, agentId: agent?.id, ms });

    const spec = this.core.tools.get(tool);
    if (!spec) {
      audit('denied', { reason: 'unknown tool' });
      return { ok: false, decision: 'denied', output: `There is no tool named "${tool}".` };
    }
    const invalid = validateArgs(spec.inputSchema, args);
    if (invalid) {
      audit('invalid', { reason: invalid });
      return { ok: false, decision: 'invalid', output: `Invalid arguments: ${invalid}` };
    }

    const mode = this.effectiveMode(call);
    let decision = 'allowed';
    if (mode === 'deny') {
      audit('denied', { reason: 'no grant' });
      return { ok: false, decision: 'denied', output: `Permission denied: you are not allowed to use ${tool}. Do not retry. Tell your owner if you need it.` };
    }
    if (mode === 'ask') {
      const verdict = await this.requestApproval(call);
      if (verdict !== 'approved') {
        audit(verdict, { reason: verdict === 'expired' ? 'nobody answered in time' : 'owner said no' });
        return {
          ok: false, decision: verdict,
          output: verdict === 'expired'
            ? `Your owner did not answer the approval request for ${tool} in time, so it did not run.`
            : `Your owner rejected this ${tool} call. Do not retry it.`,
        };
      }
      decision = 'approved';
    }

    const started = Date.now();
    try {
      const result = await Promise.race([
        spec.run(args, { core: this.core, agent, runId, chain: call.chain ?? [] }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${tool} timed out after ${EXEC_TIMEOUT_MS / 1000}s`)), EXEC_TIMEOUT_MS).unref()),
      ]);
      const output = truncate(this.core.vault.redact(result), 24_000);
      audit(decision, { result: output.slice(0, 600) }, Date.now() - started);
      return { ok: true, decision, output };
    } catch (e) {
      const message = this.core.vault.redact(errMsg(e));
      audit(decision, { error: message.slice(0, 600) }, Date.now() - started);
      return { ok: false, decision, output: `Tool error: ${message}` };
    }
  }

  private requestApproval(call: ToolCall): Promise<'approved' | 'rejected' | 'expired'> {
    const approval = this.core.store.insertApproval({
      agentId: call.agent?.id ?? null, runId: call.runId, actor: `${call.actor.type}:${call.actor.id}`,
      tool: call.tool, args: this.safeArgs(call.args ?? {}),
    });
    this.core.emit('approval', approval);
    if (call.agent) this.core.setState(call.agent.id, 'waiting');
    const minutes = Number(this.core.store.setting('approvalMinutes') ?? DEFAULT_APPROVAL_MINUTES) || DEFAULT_APPROVAL_MINUTES;

    return new Promise((resolve) => {
      const finish = (verdict: 'approved' | 'rejected' | 'expired') => {
        const w = this.waiting.get(approval.id);
        if (!w) return;
        clearTimeout(w.timer);
        this.waiting.delete(approval.id);
        if (call.agent) this.core.setState(call.agent.id, 'working');
        resolve(verdict);
      };
      const timer = setTimeout(() => {
        this.core.store.resolveApproval(approval.id, 'expired', 'system');
        this.core.emit('approval', this.core.store.approval(approval.id));
        finish('expired');
      }, minutes * 60_000);
      timer.unref();
      this.waiting.set(approval.id, { settle: (ok) => finish(ok ? 'approved' : 'rejected'), timer });
    });
  }

  /** A person answers an approval. With `always`, the agent's grant is raised to "allow" as well. */
  resolve(id: string, approve: boolean, by: Actor, always = false): Approval {
    const approval = this.core.store.approval(id);
    if (!approval) throw new HttpError(404, 'Approval not found.');
    if (approval.status !== 'pending') throw new HttpError(409, `This request is already ${approval.status}.`);
    this.core.store.resolveApproval(id, approve ? 'approved' : 'rejected', by.id);
    if (approve && always && approval.agentId) {
      const spec = this.core.tools.get(approval.tool);
      if (spec?.reviewed) {
        this.core.store.setGrant(approval.agentId, approval.tool, 'allow', by.id);
        this.log(by, 'permission.set', approval.tool, 'allow', { via: 'approval' }, { agentId: approval.agentId });
        this.core.emit('grants', { agentId: approval.agentId });
      }
    }
    const fresh = this.core.store.approval(id)!;
    this.core.emit('approval', fresh);
    this.waiting.get(id)?.settle(approve);
    return fresh;
  }

  shutdown() {
    for (const [, w] of this.waiting) clearTimeout(w.timer);
    this.waiting.clear();
  }
}
