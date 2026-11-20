import type { Core } from '../core.ts';
import type { Agent, CustomTool, Risk } from '../store.ts';
import { builtinTools } from './builtin.ts';
import { runCustomTool } from './custom.ts';

export interface ToolCtx {
  core: Core;
  /** The shadow making the call. Null when a person or a harness tests a tool directly. */
  agent: Agent | null;
  runId: string | null;
  /** Agent ids already waiting on this call, to stop shadows messaging each other in a loop. */
  chain: string[];
}

export interface ToolSpec {
  name: string;
  kind: 'builtin' | 'http' | 'js';
  description: string;
  inputSchema: Record<string, unknown>;
  risk: Risk;
  /** Custom tools made by a harness stay unreviewed (every call asks a person) until someone reviews them in the app. */
  reviewed: boolean;
  /** Secret names this tool needs before it can work. */
  needs: string[];
  config?: Record<string, unknown>;
  createdBy?: string;
  run(args: Record<string, unknown>, ctx: ToolCtx): Promise<string>;
}

export class ToolRegistry {
  private core: Core;
  private builtins: Map<string, ToolSpec>;

  constructor(core: Core) {
    this.core = core;
    this.builtins = new Map(builtinTools().map((t) => [t.name, t]));
  }

  isBuiltin(name: string) { return this.builtins.has(name); }

  private fromCustom(t: CustomTool): ToolSpec {
    const needs = Array.isArray(t.config.secrets) ? (t.config.secrets as string[]) : [];
    return {
      name: t.name, kind: t.kind, description: t.description, inputSchema: t.inputSchema, risk: t.risk,
      reviewed: t.reviewed, needs, config: t.config, createdBy: t.createdBy,
      run: (args, ctx) => runCustomTool(t, args, ctx),
    };
  }

  get(name: string): ToolSpec | undefined {
    const builtin = this.builtins.get(name);
    if (builtin) return builtin;
    const custom = this.core.store.customTool(name);
    return custom && this.fromCustom(custom);
  }

  list(): ToolSpec[] {
    return [...this.builtins.values(), ...this.core.store.customTools().map((t) => this.fromCustom(t))];
  }

  /** Serializable description, plus which of the needed secrets are still missing. */
  describe(t: ToolSpec) {
    return {
      name: t.name, kind: t.kind, description: t.description, inputSchema: t.inputSchema, risk: t.risk,
      reviewed: t.reviewed, needs: t.needs, missing: t.needs.filter((n) => !this.core.vault.has(n)),
      config: t.config ?? null, createdBy: t.createdBy ?? 'system',
    };
  }
}
