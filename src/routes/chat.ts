import type { Config } from "../config/types.ts";
import { handleOpenAICompletions, handleOpenAI, handleOpenAIResponse } from "../providers/openai.ts";
import { handleAnthropic } from "../providers/anthropic.ts";
import { handleBedrock } from "../providers/bedrock.ts";
import { XMLStreamLexer } from "../plugins/xml-tool-call-stream.ts";
import { logger } from "../utils/logger.ts";

/**
 * OpenAI 请求结构。
 * 对应 /v1/chat/completions 的标准负载。
 */
interface OpenAIRequest {
  model: string;
  stream?: boolean;
  messages: any[];
  [key: string]: any;
}

/**
 * 处理入站的 OpenAI /v1/chat/completions 请求。
 * 该路由不仅支持标准的 OpenAI 协议透传，还能拦截文本流并将其中的 XML 工具调用
 * 转译回标准的 OpenAI tool_calls 对象格式。
 * 
 * 核心流程：
 * 1. 查找上游配置并映射模型名称。
 * 2. 调度到对应的上游协议处理器。
 * 3. 如果开启了 'xml-tool-call' 插件，则启动异步生成器流处理：
 *    - 实时提取 XML 工具调用（如 <tool_call>Name(args)</tool_call>）。
 *    - 将提取到的内容实时封装为 OpenAI 的 chat.completion.chunk 格式。
 * 4. 如果未开启插件且为流式，则直接代理上游流，实现最高的转发效率。
 */
export async function handleCompletion(req: Request, config: Config): Promise<Response> {
  const method = req.method;
  const url = req.url;
  logger.info(`Handling ${method} ${url}`);

  let body: any;
  try {
    body = (await req.json()) as OpenAIRequest;
  } catch (e: any) {
    logger.error(`Error parsing request body: ${e.message}`);
    return new Response(JSON.stringify({ error: { message: "Invalid JSON payload" } }), { status: 400 });
  }

  const requestedModel = body.model;
  logger.debug("Request payload:", body);
  
  if (!requestedModel) {
    return new Response(JSON.stringify({ error: { message: "model is required" } }), { status: 400 });
  }

  const modelConf = config.modelById[requestedModel];
  if (!modelConf) {
    logger.error(`Rejecting request: Unknown model ${requestedModel}`);
    return new Response(JSON.stringify({ error: { message: "unknown model: " + requestedModel } }), { status: 404 });
  }

  // Find upstream config
  const upstreamConf = config.upstreams[modelConf.upstream];
  if (!upstreamConf) {
    logger.error(`Rejecting request: Upstream ${modelConf.upstream} not found`);
    return new Response(JSON.stringify({ error: { message: "upstream not found" } }), { status: 500 });
  }

  const hasPlugin = modelConf.plugins.includes("xml-tool-call");

  // 映射上游模型名
  const upstreamBody = { ...body, model: modelConf.upstreamModel };

  // 转发请求到上游提供商
  let fetchRes: Response;
  try {
    logger.info(`Calling upstream [${upstreamConf.protocol}] for model ${modelConf.upstreamModel}`);
    if (upstreamConf.protocol === "openai-completions") {
      fetchRes = await handleOpenAICompletions(upstreamConf, upstreamBody, req);
    } else if (upstreamConf.protocol === "openai") {
      fetchRes = await handleOpenAI(upstreamConf, upstreamBody, req);
    } else if (upstreamConf.protocol === "openai-response") {
      fetchRes = await handleOpenAIResponse(upstreamConf, upstreamBody, req);
    } else if (upstreamConf.protocol === "anthropic") {
      fetchRes = await handleAnthropic(upstreamConf, upstreamBody, req);
    } else if (upstreamConf.protocol === "bedrock") {
      fetchRes = await handleBedrock(upstreamConf, upstreamBody, req);
    } else {
      return new Response(JSON.stringify({ error: { message: `unsupported protocol: ${upstreamConf.protocol}` } }), { status: 500 });
    }
    logger.info(`Upstream responded with status ${fetchRes.status}`);
  } catch (err: any) {
    logger.error(`Upstream interface call failed: ${err.message}`);
    return new Response(JSON.stringify({ error: { message: err.message } }), { status: 502 });
  }

  // 传递上游给出的错误状态
  if (!fetchRes.ok) {
    logger.error(`Upstream response Exception, Status: ${fetchRes.status}`);
    return fetchRes;
  }

  // 非流式响应处理
  if (!upstreamBody.stream) {
    return fetchRes;
  }

  // 特殊场景：如果未启用 XML 工具调用插件，则直接进行原始流代理传输
  if (!hasPlugin) {
    return new Response(fetchRes.body, { 
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Transfer-Encoding": "chunked",
        "Content-Encoding": "identity"
      } 
    });
  }

  // 场景：启用了 XML 插件，需要进行流式拦截与内容转译
  const readable = fetchRes.body;
  if (!readable) return new Response(null, { status: 200 });
  
  const encoder = new TextEncoder();

  /**
   * 异步生成器：动态拦截上游流，处理 Lexer 多重解析，并重新封装成标准 OpenAI SSE 数据包。
   */
  async function* responseGenerator() {
    let currentId = `chatcmpl-${Date.now()}`;
    const lexer = new XMLStreamLexer();
    
    const reader = readable!.getReader();
    const decoder = new TextDecoder();
    let lineBuffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        lineBuffer += decoder.decode(value, { stream: true });
        let lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          
          const rawData = trimmed.substring(5).trim();
          if (rawData === "[DONE]") continue;

          try {
            const d = JSON.parse(rawData);
            if (d.id) currentId = d.id;
            
            // 提取内容增量文本
            const text = d?.choices?.[0]?.delta?.content || "";
            if (text) {
              // 进行 Lexer 处理（核心状态机）
              const lexed = lexer.process(text);
              for (const item of lexed) {
                if (item.type === "text") {
                  // 普通文本增量：直接回传
                  yield encoder.encode(`data: ${JSON.stringify({
                    id: currentId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: requestedModel,
                    choices: [{ index: 0, delta: { content: item.text }, finish_reason: null }]
                  })}\n\n`);
                } else if (item.type === "tool_call_start") {
                  // 工具调用开始：发射符合 OpenAI 标准的 tool_calls 起始块
                  yield encoder.encode(`data: ${JSON.stringify({
                    id: currentId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: requestedModel,
                    choices: [{ 
                      index: 0, 
                      delta: { 
                        tool_calls: [{
                            index: item.index,
                            id: item.id,
                            type: "function",
                            function: { name: item.name, arguments: "" }
                        }]
                      }, 
                      finish_reason: null 
                    }]
                  })}\n\n`);
                } else if (item.type === "tool_call_delta") {
                   // 参数增量：发射符合 OpenAI 标准的参数增量块
                   yield encoder.encode(`data: ${JSON.stringify({
                    id: currentId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: requestedModel,
                    choices: [{ 
                      index: 0, 
                      delta: { 
                        tool_calls: [{
                            id: item.id,
                            function: { arguments: item.text }
                        }]
                      }, 
                      finish_reason: null 
                    }]
                  })}\n\n`);
                }
              }
            }
          } catch (e) {
             // 忽略非关键的 JSON 解析错误
          }
        }
      }

      // 最后收尾：刷新 Lexer 缓冲区
      const lexed = lexer.flush();
      for (const item of lexed) {
        if (item.type === "text") {
          yield encoder.encode(`data: ${JSON.stringify({
            id: currentId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: requestedModel,
            choices: [{ index: 0, delta: { content: item.text }, finish_reason: null }]
          })}\n\n`);
        }
      }

      // 按 OpenAI 协议发出 finish_reason 和结束标记
      yield encoder.encode(`data: ${JSON.stringify({
        id: currentId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      })}\n\n`);
      yield encoder.encode(`data: [DONE]\n\n`);

    } catch (e) {
      logger.error("Exception during streaming generation:", e);
    } finally {
      reader.releaseLock();
    }
  }

  // 构造响应，并配置 SSE 响应头
  return new Response(responseGenerator(), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Transfer-Encoding": "chunked",
      "Content-Encoding": "identity"
    }
  });
}
