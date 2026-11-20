import { agentName } from './store';
import type { AuditEntry } from './types';

export function actorLabel(e: AuditEntry): string {
  switch (e.actorType) {
    case 'user': return 'You';
    case 'agent': return agentName(e.actorId);
    case 'mcp': return `${e.actorId} (MCP)`;
    case 'a2a': return 'A remote agent';
    default: return 'System';
  }
}

const VERBS: Record<string, string> = {
  'agent.create': 'summoned', 'agent.update': 'changed', 'agent.delete': 'dismissed', 'agent.chat': 'talked to',
  'function.add': 'added the function', 'function.update': 'changed the function', 'function.remove': 'removed the function',
  'function.run': 'ran', 'function.webhook': 'received a webhook for', 'tool.create': 'created the tool', 'tool.update': 'changed the tool',
  'tool.delete': 'deleted the tool', 'secret.set': 'stored the secret', 'secret.delete': 'deleted the secret',
  'provider.save': 'saved the AI provider', 'token.rotate': 'rotated the token for', 'a2a.message': 'messaged',
};

export type Tone = 'allow' | 'ask' | 'deny' | 'plain';

/** One plain sentence per audit entry, plus a tone for its decision chip. */
export function describe(e: AuditEntry): { text: string; chip: string; tone: Tone } {
  const who = actorLabel(e);
  if (e.action === 'tool.call') {
    const failed = typeof e.detail.error === 'string';
    const map: Record<string, [string, string, Tone]> = {
      allowed: [`${who} used ${e.target}`, failed ? 'Failed' : 'Allowed', failed ? 'deny' : 'allow'],
      approved: [`${who} used ${e.target}`, failed ? 'Failed' : 'You approved', failed ? 'deny' : 'allow'],
      denied: [`${who} tried ${e.target}`, 'Blocked', 'deny'],
      rejected: [`${who} asked for ${e.target}`, 'You rejected', 'deny'],
      expired: [`${who} asked for ${e.target}`, 'Expired', 'ask'],
      invalid: [`${who} called ${e.target} wrongly`, 'Invalid', 'ask'],
    };
    const [text, chip, tone] = map[e.decision] ?? [`${who} called ${e.target}`, e.decision, 'plain'];
    return { text, chip, tone };
  }
  if (e.action === 'permission.set') {
    const forWhom = e.agentId ? ` for ${agentName(e.agentId)}` : '';
    const capped = e.detail.requested && e.detail.requested !== e.decision ? ' (asked for allow)' : '';
    return {
      text: `${who} set ${e.target}${forWhom}${capped}`,
      chip: e.decision === 'removed' ? 'Off' : e.decision[0].toUpperCase() + e.decision.slice(1),
      tone: e.decision === 'allow' ? 'allow' : e.decision === 'ask' ? 'ask' : 'deny',
    };
  }
  return { text: `${who} ${VERBS[e.action] ?? e.action} ${e.target}`, chip: '', tone: 'plain' };
}
