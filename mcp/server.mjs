#!/usr/bin/env node
// vibecodereview MCP server (v0.1) — exposes one tool, `council_review`, that runs
// the LLM council over a diff and returns the findings. Zero-dep: newline-
// delimited JSON-RPC over stdio (the MCP stdio transport framing).
//
// Provider keys come from the environment (OPENAI_API_KEY, GEMINI_API_KEY,
// MOONSHOT_API_KEY, OPENROUTER_API_KEY). Wire into a client, e.g. Claude Code:
//   claude mcp add vibecodereview -- node /path/to/vibecodereview/mcp/server.mjs

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, "..", "scripts", "council-review.mjs");

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const TOOL = {
  name: "council_review",
  description:
    "Review a code diff with an LLM council (multiple models, distinct lenses: correctness, performance, security, maintainability). Returns markdown findings. Needs provider API keys in the server environment.",
  inputSchema: {
    type: "object",
    properties: { diff: { type: "string", description: "Unified diff to review." } },
    required: ["diff"],
  },
};

function runCouncil(diff) {
  const tmp = path.join(os.tmpdir(), `vibecodereview-mcp-${process.pid}-${Date.now()}.diff`);
  const out = path.join(os.tmpdir(), `vibecodereview-mcp-${process.pid}-${Date.now()}.md`);
  fs.writeFileSync(tmp, diff || "");
  execFileSync("node", [SCRIPT, tmp, out], { stdio: "ignore" });
  return fs.readFileSync(out, "utf8");
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "vibecodereview", version: "0.1.0" },
    });
  }
  if (method === "notifications/initialized" || method?.startsWith("notifications/")) return;
  if (method === "tools/list") return reply(id, { tools: [TOOL] });
  if (method === "tools/call") {
    if (params?.name !== "council_review") return fail(id, -32601, `Unknown tool: ${params?.name}`);
    try {
      const text = runCouncil(params?.arguments?.diff);
      return reply(id, { content: [{ type: "text", text }] });
    } catch (err) {
      return reply(id, { content: [{ type: "text", text: `Council error: ${err?.message || err}` }], isError: true });
    }
  }
  if (id !== undefined) fail(id, -32601, `Unknown method: ${method}`);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (err) {
      process.stderr.write(`parse error: ${err?.message || err}\n`);
    }
  }
});
