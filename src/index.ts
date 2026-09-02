import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

type Env = {
  CARTPANDA_STORE?: string;
  CARTPANDA_TOKEN?: string;
  CARTPANDA_API_KEY?: string;
};

function normalizeStore(value?: string) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

function getToken(env: Env) {
  return String(env.CARTPANDA_API_KEY || env.CARTPANDA_TOKEN || "").trim();
}

async function tryCartPandaGet(env: Env, path: string) {
  const store = normalizeStore(env.CARTPANDA_STORE);
  const token = getToken(env);

  if (!store) throw new Error("CARTPANDA_STORE não configurado no Cloudflare Worker.");
  if (!token) throw new Error("CARTPANDA_API_KEY/CARTPANDA_TOKEN não configurado no Cloudflare Worker.");

  const safePath = path.startsWith("/") ? path : `/${path}`;
  if (/^https?:\/\//i.test(safePath)) throw new Error("Use apenas um caminho relativo da API.");

  const candidates = [
    { url: `https://${store}${safePath}`, headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
    { url: `https://${store}${safePath}`, headers: { "X-API-Token": token, Accept: "application/json" } },
    { url: `https://${store}${safePath}`, headers: { token, Accept: "application/json" } },
  ];

  const attempts: Array<Record<string, unknown>> = [];

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate.url, { method: "GET", headers: candidate.headers });
      const text = await response.text();
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch {}

      attempts.push({ url: candidate.url, status: response.status });

      if (response.ok) {
        return { ok: true, status: response.status, url: candidate.url, data: parsed, attempts };
      }
    } catch (error) {
      attempts.push({ error: String(error) });
    }
  }

  return { ok: false, attempts };
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "CartPanda MT Sports",
    version: "1.1.0",
  });

  server.registerTool(
    "cartpanda_status",
    {
      description: "Verifica se o MCP e as credenciais da CartPanda estão configurados no Cloudflare.",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              mcp: "online",
              store: normalizeStore(env.CARTPANDA_STORE) || null,
              storeConfigured: Boolean(env.CARTPANDA_STORE),
              tokenConfigured: Boolean(getToken(env)),
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerTool(
    "cartpanda_get",
    {
      description: "Faz uma consulta GET de leitura na API da CartPanda usando as credenciais guardadas no Cloudflare.",
      inputSchema: {
        path: z.string().describe("Caminho relativo da API, por exemplo /api/v3/orders"),
      },
    },
    async ({ path }) => {
      const result = await tryCartPandaGet(env, path);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: !result.ok,
      };
    },
  );

  server.registerTool(
    "cartpanda_testar_pedidos",
    {
      description: "Testa os caminhos comuns de pedidos da CartPanda e retorna o primeiro que responder corretamente.",
      inputSchema: {},
    },
    async () => {
      const paths = ["/api/v3/orders", "/api/orders", "/api/v1/orders"];
      const results = [];

      for (const path of paths) {
        const result = await tryCartPandaGet(env, path);
        results.push({ path, ...result });
        if (result.ok) break;
      }

      const ok = results.some((item) => item.ok);
      return {
        content: [{ type: "text", text: JSON.stringify({ ok, results }, null, 2) }],
        isError: !ok,
      };
    },
  );

  return server;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("CartPanda MCP online. Use /mcp para conectar.");
    }

    if (url.pathname === "/mcp") {
      return createMcpHandler(() => createServer(env))(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
