import fs from 'node:fs/promises';
import path from 'node:path';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import type { ToolCtx, ToolSpec } from './registry.ts';
import { newId, truncate } from '../util.ts';

type Args = Record<string, unknown>;
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });

function needAgent(ctx: ToolCtx) {
  if (!ctx.agent) throw new Error('This tool only works when a shadow calls it.');
  return ctx.agent;
}
function needSecret(ctx: ToolCtx, name: string): string {
  const v = ctx.core.vault.get(name);
  if (!v) throw new Error(`Secret ${name} is not set. Ask your owner to add it in Settings → Secrets.`);
  return v;
}

/** The server must not be reachable through an agent's own web requests. */
function assertNotSelf(ctx: ToolCtx, raw: string): URL {
  const url = new URL(raw);
  if (!/^https?:$/.test(url.protocol)) throw new Error('Only http and https URLs are allowed.');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const local = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', 'host.docker.internal'].includes(url.hostname);
  if (local && port === ctx.core.port) throw new Error('Requests to the Shadow Agent server itself are blocked.');
  return url;
}

async function workspacePath(ctx: ToolCtx, rel: string): Promise<string> {
  const root = path.join(ctx.core.home, 'workspaces', needAgent(ctx).id);
  await fs.mkdir(root, { recursive: true });
  const full = path.resolve(root, rel || '.');
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('Path is outside your workspace.');
  return full;
}

const htmlToText = (html: string) =>
  html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();

function imapConfig(ctx: ToolCtx) {
  const port = Number(ctx.core.vault.get('IMAP_PORT') ?? 993);
  return {
    host: needSecret(ctx, 'IMAP_HOST'), port,
    secure: (ctx.core.vault.get('IMAP_TLS') ?? (port === 993 ? 'true' : 'false')) === 'true',
    auth: { user: needSecret(ctx, 'IMAP_USER'), pass: needSecret(ctx, 'IMAP_PASS') },
    logger: false as const,
    tls: { rejectUnauthorized: ctx.core.vault.get('IMAP_INSECURE') !== 'true' },
  };
}

export function builtinTools(): ToolSpec[] {
  const tools: (Omit<ToolSpec, 'kind' | 'reviewed' | 'needs'> & { needs?: string[] })[] = [
    {
      name: 'notify',
      risk: 'safe',
      description: 'Send a notification to your owner. It appears in their inbox and as a desktop notification. Use it for anything they should know about; keep the title short and put the detail in the body.',
      inputSchema: obj({
        title: { type: 'string', description: 'Short headline, under 80 characters.' },
        body: { type: 'string', description: 'The detail, in plain text.' },
        level: { type: 'string', enum: ['info', 'success', 'warning', 'urgent'], description: 'How much attention it needs. Default info.' },
      }, ['title']),
      async run(args: Args, ctx: ToolCtx) {
        const note = ctx.core.store.insertNotification({
          agentId: ctx.agent?.id ?? null, title: str(args.title).slice(0, 200), body: str(args.body).slice(0, 4000),
          level: (['info', 'success', 'warning', 'urgent'].includes(str(args.level)) ? args.level : 'info') as 'info',
        });
        ctx.core.emit('notification', note);
        const push = ctx.core.store.setting('notifyUrl');
        if (push) {
          // Optional phone push through an ntfy-style endpoint. Failure here must not fail the notification.
          fetch(push, { method: 'POST', headers: { Title: note.title.replace(/[^\x20-\x7e]/g, '?') }, body: note.body || note.title, signal: AbortSignal.timeout(8000) }).catch(() => {});
        }
        return 'Notification delivered.';
      },
    },
    {
      name: 'memory_set',
      risk: 'safe',
      description: 'Save a value in your long-term memory under a key. Memory survives between runs. Pass an empty value to delete the key.',
      inputSchema: obj({ key: { type: 'string' }, value: { type: 'string' } }, ['key', 'value']),
      async run(args: Args, ctx: ToolCtx) {
        const value = str(args.value);
        ctx.core.store.memorySet(needAgent(ctx).id, str(args.key).slice(0, 120), value === '' ? null : value.slice(0, 20_000));
        return value === '' ? 'Deleted.' : 'Saved.';
      },
    },
    {
      name: 'memory_get',
      risk: 'safe',
      description: 'Read a value from your long-term memory. Leave key empty to list every key with its value.',
      inputSchema: obj({ key: { type: 'string' } }),
      async run(args: Args, ctx: ToolCtx) {
        const agent = needAgent(ctx);
        if (!str(args.key)) {
          const all = ctx.core.store.memory(agent.id);
          return all.length ? all.map((m) => `${m.key} = ${m.value}`).join('\n') : 'Memory is empty.';
        }
        return ctx.core.store.memoryGet(agent.id, str(args.key)) ?? '(no value saved under that key)';
      },
    },
    {
      name: 'http_fetch',
      risk: 'read',
      description: 'Fetch a web page or call an HTTP API. Returns the status and the response as text (HTML is reduced to readable text unless raw is true). Sending a POST, PUT, PATCH or DELETE can change things on the other side.',
      inputSchema: obj({
        url: { type: 'string' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        headers: { type: 'object' },
        body: { type: 'string' },
        raw: { type: 'boolean', description: 'Return the body unchanged instead of reducing HTML to text.' },
      }, ['url']),
      async run(args: Args, ctx: ToolCtx) {
        const url = assertNotSelf(ctx, str(args.url));
        const method = str(args.method, 'GET');
        const res = await fetch(url, {
          method, headers: { 'user-agent': 'ShadowAgent/0.1', ...((args.headers as Record<string, string>) ?? {}) },
          body: method === 'GET' ? undefined : str(args.body) || undefined, signal: AbortSignal.timeout(30_000), redirect: 'follow',
        });
        const text = await res.text();
        const isHtml = (res.headers.get('content-type') ?? '').includes('html');
        return `HTTP ${res.status}\n${isHtml && !args.raw ? htmlToText(text) : text}`;
      },
    },
    {
      name: 'rss_read',
      risk: 'read',
      description: 'Read an RSS or Atom feed and return its newest items (title, link, date, summary).',
      inputSchema: obj({ url: { type: 'string' }, limit: { type: 'integer', description: 'Maximum items, default 10.' } }, ['url']),
      async run(args: Args, ctx: ToolCtx) {
        const res = await fetch(assertNotSelf(ctx, str(args.url)), { headers: { 'user-agent': 'ShadowAgent/0.1' }, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`Feed returned HTTP ${res.status}`);
        const xml = await res.text();
        const pick = (chunk: string, tag: string) => {
          const m = chunk.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
          return m ? htmlToText(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')) : '';
        };
        const items = [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].slice(0, num(args.limit, 10)).map((m) => {
          const chunk = m[0];
          const link = pick(chunk, 'link') || chunk.match(/<link[^>]*href="([^"]+)"/i)?.[1] || '';
          return { title: pick(chunk, 'title'), link, date: pick(chunk, 'pubDate') || pick(chunk, 'updated') || pick(chunk, 'published'), summary: (pick(chunk, 'description') || pick(chunk, 'summary')).slice(0, 400) };
        });
        return items.length ? JSON.stringify(items, null, 2) : 'The feed has no items.';
      },
    },
    {
      name: 'email_fetch',
      risk: 'read',
      needs: ['IMAP_HOST', 'IMAP_USER', 'IMAP_PASS'],
      description: 'Read recent emails from your owner\'s mailbox over IMAP. Returns uid, sender, subject, date and the start of the body for each message, oldest first. To see only mail that arrived since your last check, save the highest uid in memory and pass it back as after_uid. Reading does not mark messages as read.',
      inputSchema: obj({
        mailbox: { type: 'string', description: 'Folder name, default INBOX.' },
        unseen_only: { type: 'boolean', description: 'Only messages not yet read.' },
        after_uid: { type: 'integer', description: 'Only messages with a uid higher than this.' },
        limit: { type: 'integer', description: 'Maximum messages, default 10, at most 30.' },
      }),
      async run(args: Args, ctx: ToolCtx) {
        const client = new ImapFlow(imapConfig(ctx));
        await client.connect();
        try {
          const lock = await client.getMailboxLock(str(args.mailbox, 'INBOX'));
          try {
            const query: Record<string, unknown> = {};
            if (args.unseen_only) query.seen = false;
            if (typeof args.after_uid === 'number') query.uid = `${args.after_uid + 1}:*`;
            if (!Object.keys(query).length) query.all = true;
            const found = (await client.search(query, { uid: true })) || [];
            // IMAP returns the last message for "n:*" even when n is past the end, so filter again.
            const uids = found.filter((u) => typeof args.after_uid !== 'number' || u > (args.after_uid as number)).slice(-Math.min(num(args.limit, 10), 30));
            if (!uids.length) return 'No matching messages.';
            const out: Record<string, unknown>[] = [];
            for await (const msg of client.fetch(uids, { envelope: true, source: true, flags: true }, { uid: true })) {
              const parsed = msg.source ? await simpleParser(msg.source) : null;
              const body = parsed?.text || (parsed?.html ? htmlToText(parsed.html) : '');
              out.push({
                uid: msg.uid,
                from: msg.envelope?.from?.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', '),
                subject: msg.envelope?.subject ?? '(no subject)',
                date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : undefined,
                unread: !msg.flags?.has('\\Seen'),
                body: body.replace(/\s+/g, ' ').trim().slice(0, 1200),
              });
            }
            return JSON.stringify(out, null, 2);
          } finally {
            lock.release();
          }
        } finally {
          await client.logout().catch(() => {});
        }
      },
    },
    {
      name: 'email_send',
      risk: 'act',
      needs: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'],
      description: 'Send an email from your owner\'s account over SMTP. This goes to real people and cannot be undone.',
      inputSchema: obj({ to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string', description: 'Plain text body.' } }, ['to', 'subject', 'body']),
      async run(args: Args, ctx: ToolCtx) {
        const port = Number(ctx.core.vault.get('SMTP_PORT') ?? 587);
        const user = ctx.core.vault.get('SMTP_USER');
        const transport = nodemailer.createTransport({
          host: needSecret(ctx, 'SMTP_HOST'), port, secure: port === 465,
          ...(user ? { auth: { user, pass: needSecret(ctx, 'SMTP_PASS') } } : {}),
          tls: { rejectUnauthorized: ctx.core.vault.get('SMTP_INSECURE') !== 'true' },
        });
        const info = await transport.sendMail({ from: ctx.core.vault.get('SMTP_FROM') ?? user, to: str(args.to), subject: str(args.subject), text: str(args.body) });
        return `Sent to ${str(args.to)} (message id ${info.messageId}).`;
      },
    },
    {
      name: 'file_read',
      risk: 'safe',
      description: 'Read a text file from your private workspace folder. Pass a folder path (or nothing) to list files.',
      inputSchema: obj({ path: { type: 'string' } }),
      async run(args: Args, ctx: ToolCtx) {
        const full = await workspacePath(ctx, str(args.path));
        const stat = await fs.stat(full).catch(() => null);
        if (!stat) return 'No such file.';
        if (stat.isDirectory()) return (await fs.readdir(full)).join('\n') || '(empty folder)';
        return fs.readFile(full, 'utf8');
      },
    },
    {
      name: 'file_write',
      risk: 'safe',
      description: 'Write a text file in your private workspace folder, replacing it if it exists. Set append to add to the end instead.',
      inputSchema: obj({ path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean' } }, ['path', 'content']),
      async run(args: Args, ctx: ToolCtx) {
        const full = await workspacePath(ctx, str(args.path));
        await fs.mkdir(path.dirname(full), { recursive: true });
        if (args.append) await fs.appendFile(full, str(args.content));
        else await fs.writeFile(full, str(args.content));
        return `Wrote ${str(args.content).length} characters to ${str(args.path)}.`;
      },
    },
    {
      name: 'agent_message',
      risk: 'read',
      description: 'Send a message to another shadow on this machine and wait for its reply. Use it to delegate work or ask for information another shadow is responsible for.',
      inputSchema: obj({ agent: { type: 'string', description: 'Name of the shadow to message.' }, message: { type: 'string' } }, ['agent', 'message']),
      async run(args: Args, ctx: ToolCtx) {
        const me = needAgent(ctx);
        const target = ctx.core.store.agent(str(args.agent));
        if (!target) throw new Error(`There is no shadow named "${str(args.agent)}".`);
        if (target.id === me.id) throw new Error('You cannot message yourself.');
        if (ctx.chain.includes(target.id)) throw new Error(`${target.name} is already waiting on this conversation; messaging it again would loop.`);
        if (target.status !== 'active') throw new Error(`${target.name} is paused.`);
        const run = await ctx.core.runtime.run(target.id, {
          trigger: 'agent', input: `Message from fellow shadow ${me.name}:\n\n${str(args.message)}`, chain: [...ctx.chain, me.id],
        });
        if (run.status !== 'completed') throw new Error(`${target.name} failed: ${run.error}`);
        return run.output || '(no reply)';
      },
    },
    {
      name: 'a2a_call',
      risk: 'act',
      description: 'Send a message to a remote agent that speaks the A2A (agent-to-agent) protocol and return its answer. Whatever you send leaves this machine.',
      inputSchema: obj({
        url: { type: 'string', description: 'The remote agent\'s A2A endpoint URL.' },
        message: { type: 'string' },
        token_secret: { type: 'string', description: 'Name of a secret holding the bearer token, if the agent needs one.' },
      }, ['url', 'message']),
      async run(args: Args, ctx: ToolCtx) {
        const token = str(args.token_secret) ? needSecret(ctx, str(args.token_secret)) : undefined;
        const res = await fetch(assertNotSelf(ctx, str(args.url)), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({
            jsonrpc: '2.0', id: newId('rpc'), method: 'message/send',
            params: { message: { kind: 'message', role: 'user', messageId: newId('msg'), parts: [{ kind: 'text', text: str(args.message) }] } },
          }),
          signal: AbortSignal.timeout(120_000),
        });
        const data = (await res.json()) as { error?: { message: string }; result?: Record<string, unknown> };
        if (data.error) throw new Error(`Remote agent error: ${data.error.message}`);
        return extractA2aText(data.result) || JSON.stringify(data.result);
      },
    },
    {
      name: 'time_now',
      risk: 'safe',
      description: 'Get the current date and time, in ISO format and in the server\'s local time zone.',
      inputSchema: obj({}),
      async run() {
        const d = new Date();
        return `${d.toISOString()} (local: ${d.toString()})`;
      },
    },
  ];

  return tools.map((t) => ({
    ...t, kind: 'builtin' as const, reviewed: true, needs: t.needs ?? [],
    run: async (args: Args, ctx: ToolCtx) => truncate(await t.run(args, ctx), 24_000),
  }));
}

type Part = { kind?: string; text?: string };
/** Pull the readable text out of an A2A Task or Message result. */
export function extractA2aText(result: Record<string, unknown> | undefined): string {
  if (!result) return '';
  const texts = (parts: unknown) => (Array.isArray(parts) ? (parts as Part[]).filter((p) => p.kind === 'text' && p.text).map((p) => p.text!) : []);
  const out: string[] = [];
  for (const artifact of (result.artifacts as { parts?: unknown }[] | undefined) ?? []) out.push(...texts(artifact.parts));
  if (!out.length) out.push(...texts((result.status as { message?: { parts?: unknown } } | undefined)?.message?.parts));
  if (!out.length) out.push(...texts(result.parts));
  return out.join('\n').trim();
}
