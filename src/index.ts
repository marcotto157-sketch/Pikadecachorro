import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

type Env = {
  CARTPANDA_STORE?: string;
  CARTPANDA_TOKEN?: string;
  CARTPANDA_API_KEY?: string;
  MCP_AUTH_TOKEN?: string;
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
  if (!/^[a-z0-9-]+\.mycartpanda\.com$/i.test(store)) throw new Error("Domínio da loja inválido.");
  if (!token) throw new Error("CARTPANDA_API_KEY não configurado no Cloudflare Worker.");

  // Preserve the existing /api/v3/orders input format while using the official API.
  const relative = path.replace(/^\/api\/(?:v[13]\/)?/, "/");
  if (!/^\/?[a-z][a-z0-9_/-]*(?:\?[^#\\\r\n]*)?$/i.test(relative)) {
    throw new Error("Use apenas um caminho relativo da API, como /orders/count.");
  }
  const slug = store.split(".")[0];
  const base = `https://accounts.cartpanda.com/api/v3/${slug}/`;
  const target = new URL(relative.replace(/^\//, ""), base);
  if (!target.href.startsWith(base)) throw new Error("Caminho fora da API da loja.");
  const response = await fetch(target, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    await response.body?.cancel();
    return { ok: false, status: response.status, error: "A API da CartPanda não retornou uma resposta JSON de sucesso." };
  }
  const reader = response.body?.getReader();
  if (!reader) return { ok: false, status: response.status, error: "Resposta vazia." };
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 2 * 1024 * 1024) {
      await reader.cancel();
      return { ok: false, status: 413, error: "Resposta muito grande. Use paginação." };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const text = new TextDecoder().decode(bytes).replaceAll(token, "[REDACTED]");
  try { return { ok: true, status: response.status, data: JSON.parse(text) }; }
  catch { return { ok: false, status: response.status, error: "JSON inválido." }; }
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
      description: "Verifica o acesso à CartPanda consultando apenas a contagem de pedidos.",
      inputSchema: {},
    },
    async () => {
      const result = await tryCartPandaGet(env, "/orders/count");
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: !result.ok,
      };
    },
  );

  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("CartPanda MCP online. Use /mcp para conectar.");
    }

    if (url.pathname === "/mcp") {
      if (!env.MCP_AUTH_TOKEN) {
        return new Response("MCP authentication is not configured.", { status: 503 });
      }
      const expected = new TextEncoder().encode(`Bearer ${env.MCP_AUTH_TOKEN}`);
      const supplied = new TextEncoder().encode(request.headers.get("Authorization") || "");
      if (expected.length !== supplied.length || !crypto.subtle.timingSafeEqual(expected, supplied)) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": 'Bearer realm="cartpandamcp"', "Cache-Control": "no-store" },
        });
      }
      return createMcpHandler(() => createServer(env))(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
