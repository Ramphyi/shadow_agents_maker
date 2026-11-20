import crypto from 'node:crypto';

export const now = () => Date.now();
export const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
export const newToken = (prefix: string) => `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;

export const slug = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… [truncated ${s.length - max} characters]`;
}

export function safeJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** An error whose message is safe to show to API / MCP callers, with an HTTP status. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,47}$/;

type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; enum?: unknown[]; items?: Schema };

/** Minimal JSON-schema check (types, required, enum). Returns an error string or null. */
export function validateArgs(schema: Schema | undefined, value: unknown, path = 'input'): string | null {
  if (!schema || !schema.type) return null;
  const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  const want = schema.type;
  const ok =
    want === actual ||
    (want === 'integer' && actual === 'number' && Number.isInteger(value)) ||
    (want === 'number' && actual === 'number');
  if (!ok) return `${path} must be ${want}, got ${actual}`;
  if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.join(', ')}`;
  if (want === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (obj[key] === undefined || obj[key] === null) return `${path}.${key} is required`;
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (obj[key] === undefined || obj[key] === null) continue;
      const err = validateArgs(sub, obj[key], `${path}.${key}`);
      if (err) return err;
    }
  }
  if (want === 'array' && schema.items) {
    for (const [i, item] of (value as unknown[]).entries()) {
      const err = validateArgs(schema.items, item, `${path}[${i}]`);
      if (err) return err;
    }
  }
  return null;
}
