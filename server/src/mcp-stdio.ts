#!/usr/bin/env node
/**
 * stdio bridge for MCP clients that cannot speak HTTP. It forwards everything to the running Shadow Agent
 * server, so the agents, scheduler and gateway stay in one process.
 *
 *   SHADOW_URL    default http://127.0.0.1:7777
 *   SHADOW_TOKEN  default: contents of ~/.shadowagent/mcp.token
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const base = (process.env.SHADOW_URL ?? 'http://127.0.0.1:7777').replace(/\/+$/, '');
const home = process.env.SHADOW_HOME ?? path.join(os.homedir(), '.shadowagent');
const tokenFile = path.join(home, 'mcp.token');
const token = process.env.SHADOW_TOKEN ?? (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '');
if (!token) {
  console.error(`No MCP token. Start the Shadow Agent server once, or set SHADOW_TOKEN (looked in ${tokenFile}).`);
  process.exit(1);
}

const upstream = new Client({ name: 'shadow-mcp-stdio', version: '0.1.0' });
await upstream.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
  requestInit: { headers: { authorization: `Bearer ${token}` } },
}));

const server = new Server({ name: 'shadow-agents', version: '0.1.0' }, {
  capabilities: { tools: {} },
  instructions: upstream.getInstructions(),
});
server.setRequestHandler(ListToolsRequestSchema, () => upstream.listTools());
server.setRequestHandler(CallToolRequestSchema, (req) => upstream.callTool(req.params, undefined, { timeout: 3_600_000 }));
await server.connect(new StdioServerTransport());
