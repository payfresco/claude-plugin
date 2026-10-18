// Minimal, dependency-free MCP server (Streamable HTTP, stateless, JSON responses).
// Runs on Supabase Edge Functions (Deno). Spec: https://modelcontextprotocol.io

export type Json = Record<string, unknown>;

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  annotations?: Json;
  handler: (args: Json, ctx: Ctx) => Promise<ToolResult> | ToolResult;
}

export interface ToolResult {
  text: string;
  data?: Json;
  isError?: boolean;
}

export interface Ctx {
  req: Request;
  ipHash: string;
  userAgent: string;
}

export interface ServerConfig {
  name: string;
  title: string;
  version: string;
  instructions: string;
  tools: ToolDef[];
  onToolCall?: (tool: string, ctx: Ctx, ok: boolean) => Promise<void>;
}

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 64 * 1024;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function serve(cfg: ServerConfig) {
  const byName = new Map(cfg.tools.map((t) => [t.name, t]));

  async function handle(msg: Json, ctx: Ctx): Promise<Json | null> {
    const id = msg.id;
    const method = msg.method as string;
    const isNotification = id === undefined;
    if (msg.jsonrpc !== "2.0" || typeof method !== "string") {
      return isNotification ? null : rpcError(id, -32600, "Invalid Request");
    }
    if (isNotification) return null; // notifications/initialized, cancelled, etc.

    switch (method) {
      case "initialize": {
        const p = (msg.params ?? {}) as Json;
        const requested = String(p.protocolVersion ?? "");
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: SUPPORTED.includes(requested) ? requested : SUPPORTED[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: cfg.name, title: cfg.title, version: cfg.version },
            instructions: cfg.instructions,
          },
        };
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: cfg.tools.map((t) => ({
              name: t.name,
              title: t.title,
              description: t.description,
              inputSchema: t.inputSchema,
              annotations: { title: t.title, ...(t.annotations ?? {}) },
            })),
          },
        };
      case "resources/list":
        return { jsonrpc: "2.0", id, result: { resources: [] } };
      case "prompts/list":
        return { jsonrpc: "2.0", id, result: { prompts: [] } };
      case "tools/call": {
        const p = (msg.params ?? {}) as Json;
        const tool = byName.get(String(p.name));
        if (!tool) return rpcError(id, -32602, `Unknown tool: ${p.name}`);
        const args = (p.arguments && typeof p.arguments === "object" ? p.arguments : {}) as Json;
        let res: ToolResult;
        try {
          res = await tool.handler(args, ctx);
        } catch (e) {
          res = { text: `Error: ${(e as Error).message}`, isError: true };
        }
        cfg.onToolCall?.(tool.name, ctx, !res.isError).catch(() => {});
        const result: Json = {
          content: [{ type: "text", text: res.text }],
          isError: !!res.isError,
        };
        // Text only: clients that prefer structuredContent would otherwise miss the full guidance.
        return { jsonrpc: "2.0", id, result };
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method === "GET") {
      // No server-initiated SSE stream. Return a friendly health/info payload for browsers,
      // 405 for MCP clients asking for an event stream.
      if ((req.headers.get("accept") ?? "").includes("text/event-stream")) {
        return new Response("Method Not Allowed", { status: 405, headers: CORS });
      }
      return json({ name: cfg.title, mcp: true, transport: "streamable-http", tools: cfg.tools.map((t) => t.name) });
    }
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS });

    const raw = await req.text();
    if (raw.length > MAX_BODY) return json(rpcError(null, -32600, "Request too large"), 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(rpcError(null, -32700, "Parse error"), 400);
    }

    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
    const ctx: Ctx = {
      req,
      ipHash: await sha256(`${cfg.name}:${ip}`),
      userAgent: (req.headers.get("user-agent") ?? "").slice(0, 200),
    };

    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handle(m as Json, ctx)))).filter(Boolean);
      return out.length ? json(out) : new Response(null, { status: 202, headers: CORS });
    }
    const out = await handle(body as Json, ctx);
    return out ? json(out) : new Response(null, { status: 202, headers: CORS });
  });
}

// ---------- helpers shared by tool modules ----------

export function num(v: unknown, def: number | null = null, min = -Infinity, max = Infinity): number | null {
  const n = typeof v === "string" ? Number(v.replace(/[$,%\s]/g, "")) : Number(v);
  if (v === undefined || v === null || v === "" || !Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export function str(v: unknown, max = 500): string {
  return v === undefined || v === null ? "" : String(v).trim().slice(0, max);
}

export function bool(v: unknown): boolean {
  return v === true || v === "true" || v === "yes" || v === 1;
}

export const usd = (n: number) =>
  "$" + Math.round(n).toLocaleString("en-US");

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// PostgREST access with the service role (auto-injected env on Supabase Edge Functions).
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

export async function dbInsert(table: string, row: Json): Promise<Json> {
  const r = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`Could not save submission (${r.status}).`);
  const rows = await r.json();
  return rows[0];
}

export async function dbCountRecent(table: string, ipHash: string, minutes: number): Promise<number> {
  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  const r = await fetch(
    `${SB_URL}/rest/v1/${table}?select=id&ip_hash=eq.${ipHash}&created_at=gte.${since}`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Prefer: "count=exact", Range: "0-0" } },
  );
  const range = r.headers.get("content-range") ?? "*/0";
  return Number(range.split("/")[1]) || 0;
}

export async function sendAlert(
  subject: string,
  html: string,
  defaults: { to: string; from: string },
  replyTo?: string,
): Promise<boolean> {
  const key = Deno.env.get("RESEND_API_KEY");
  const to = Deno.env.get("LEAD_ALERT_TO") || defaults.to;
  const from = Deno.env.get("LEAD_ALERT_FROM") || defaults.from;
  if (!key || !to || !from) return false;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: to.split(",").map((s) => s.trim()),
      subject,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  return r.ok;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export function leadTable(fields: [string, string][]): string {
  return `<table style="font-family:sans-serif;font-size:14px;border-collapse:collapse">${
    fields.filter(([, v]) => v).map(([k, v]) =>
      `<tr><td style="padding:4px 12px 4px 0;color:#666">${esc(k)}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>`
    ).join("")
  }</table>`;
}
