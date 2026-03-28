import { loadConfig } from "./config/index.ts";
import { handleCompletion } from "./routes/chat.ts";
import { handleMessages } from "./routes/messages.ts";

const config = loadConfig();

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  async fetch(req) {
    const url = new URL(req.url);
    // 采用最原始的 console.log 记录，绕过任何潜在的 logger 异常，确保入站必有痕迹
    console.log(`[${new Date().toISOString()}] Incoming: ${req.method} ${url.pathname}`);
    if (url.pathname === "/healthz") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.pathname === "/v1/models" || url.pathname === "/models") {
      return new Response(JSON.stringify({
        object: "list",
        data: config.models.map(m => ({
          id: m.id,
          object: "model",
          upstream: m.upstream
        }))
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      try {
        return await handleCompletion(req, config);
      } catch (e: any) {
        console.error("Handler error:", e);
        return new Response(JSON.stringify({ error: { message: e.message } }), { status: 500 });
      }
    }

    if (url.pathname === "/v1/messages" && req.method === "POST") {
      try {
        return await handleMessages(req, config);
      } catch (e: any) {
        console.error("Handler error:", e);
        return new Response(JSON.stringify({ error: { message: e.message } }), { status: 500 });
      }
    }

    return new Response(JSON.stringify({ error: { message: "route not found" } }), { status: 404 });
  }
});

console.log(`🚀 Protoflux Gateway running on http://${server.hostname}:${server.port}`);
console.log(`Loaded ${config.models.length} models across ${Object.keys(config.upstreams).length} upstreams.`);
