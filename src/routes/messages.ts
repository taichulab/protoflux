import type { Config } from "../config/types.ts";
import { handleOpenAICompletions, handleOpenAI, handleOpenAIResponse } from "../providers/openai.ts";
import { handleAnthropic } from "../providers/anthropic.ts";
import { handleBedrock } from "../providers/bedrock.ts";
import { XMLStreamLexer, type LexerResult } from "../plugins/xml-tool-call-stream.ts";
import { OpenAIToAnthropicTranslator } from "../protocols/openai-to-anthropic-stream.ts";
import { logger } from "../utils/logger.ts";

/**
 * Anthropic 请求结构定义。
 * 包含了模型、消息列表、流式控制以及系统提示词等核心字段。
 */
interface AnthropicRequest {
  model: string;
  messages: any[];
  max_tokens?: number;
  stream?: boolean;
  system?: any;
  [key: string]: any;
}

/**
 * 处理入站的 Anthropic /v1/messages 请求。
 * 该函数的核心逻辑是将 Anthropic 协议请求映射为上游支持的 OpenAI/DashScope 协议，
 * 然后实时拦截、解析并转译上游的流式响应。
 * 
 * 核心流程：
 * 1. 解析 Anthropic 请求体。
 * 2. 根据模型 ID 查找对应的上游配置（Upstream Config）。
 * 3. 将消息格式从 Anthropic 转换为 OpenAI 标准（处理 system prompt, role 映射等）。
 * 4. 调用上游接口并获取 ReadableStream。
 * 5. 使用 Async Generator 对流进行实时处理：
 *    - Lexer：负责监测并提取文本流中的 XML 工具调用。
 *    - Translator：负责将 OpenAI SSE 事件转译为 Anthropic SSE 事件。
 */
export async function handleMessages(req: Request, config: Config): Promise<Response> {
  const method = req.method;
  const url = req.url;
  logger.info(`Handling ${method} ${url}`);

  let body: any;
  try {
    // 防御性处理：确保不会因为 Body 为空或数据损坏导致 Handler 无限制挂起
    body = (await req.json()) as AnthropicRequest;
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

  // 2. Find upstream config
  const upstreamConf = config.upstreams[modelConf.upstream];
  if (!upstreamConf) {
    logger.error(`Rejecting request: Upstream ${modelConf.upstream} not found`);
    return new Response(JSON.stringify({ error: { message: "upstream not found" } }), { status: 500 });
  }

  // 3. 将 Anthropic 消息结构递归映射为 OpenAI 格式（重要：支持 Claude Code 的多 Block 结构）
  const mappedMessages = body.messages.map((m: any) => {
    let content = "";
    if (typeof m.content === "string") {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      // 遍历所有 Block，提取并拼接其中的文本内容
      content = m.content
        .map((c: any) => {
          if (c.type === "text") return c.text || "";
          // 同时也支持将 tool_result 等关键上下文中的文本部分包含进来（如果存在）
          if (c.type === "tool_result") return typeof c.content === "string" ? c.content : (c.content?.[0]?.text || "");
          return "";
        })
        .join("\n");
    }
    return { role: m.role, content };
  });

  // --- 确定性工具名重写 (Inbound Rewriting) ---
  const toolMapping: Record<string, string> = {}; // { Simplified: Original }
  if (body.tools && Array.isArray(body.tools)) {
    body.tools = body.tools.map((tool: any) => {
      const originalName = tool.name;
      // 策略：取最后一个双下划线后的部分作为基名 (e.g. mcp__acp__Read -> Read)
      const nameParts = originalName.split("__");
      let simplifiedName = nameParts[nameParts.length - 1];
      
      // 冲突处理：如果简化的名字已存在且对应的原名不同，则加序号
      let counter = 1;
      const baseName = simplifiedName;
      while (toolMapping[simplifiedName] && toolMapping[simplifiedName] !== originalName) {
         simplifiedName = `${baseName}_${counter++}`;
      }
      
      toolMapping[simplifiedName] = originalName;
      logger.info(`Tool Rewrite: [${originalName}] -> [${simplifiedName}]`);
      return { ...tool, name: simplifiedName };
    });
  }

  // --- 确定性工具结构转设 (Structure Translation: Anthropic -> OpenAI) ---
  // 部分模型（如 GLM-5 或標準 OpenAI 接口）要求 OpenAI 格式：{ type: "function", function: { name, description, parameters } }
  // 而 Claude Code 發送的是 Anthropic 格式：{ name, description, input_schema }
  const needsOpenAITools = 
    upstreamConf.protocol.startsWith("openai") || 
    requestedModel.toLowerCase().includes("glm") || 
    (modelConf.upstreamModel && modelConf.upstreamModel.toLowerCase().includes("glm"));

  let finalTools = body.tools;
  if (needsOpenAITools && body.tools && Array.isArray(body.tools)) {
    finalTools = body.tools.map((tool: any) => {
      // 如果已經是 OpenAI 格式則跳過（防禦性）
      if (tool.type === "function") return tool;
      
      return {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema // Anthropic 的 input_schema 對應 OpenAI 的 parameters
        }
      };
    });
    logger.info(`Tool Structure Translated: Anthropic -> OpenAI (Target: ${requestedModel})`);
  }

  // 如果请求中包含单独的 system 字段，则将其转换为 OpenAI 的 system 角色消息
  if (body.system) {
    const systemContent = typeof body.system === "string" ? body.system : body.system[0]?.text || "";
    if (systemContent) {
       mappedMessages.unshift({ role: "system", content: systemContent });
    }
  }

  // 构造发往上游的 Payload
  const upstreamBody = {
    model: modelConf.upstreamModel,
    messages: mappedMessages,
    stream: body.stream || false,
    max_tokens: body.max_tokens || 1024,
    temperature: body.temperature || 0.7,
    tools: finalTools, // 透传重写或转设后的工具列表
  };

  // 4. 调用上游 Provider
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
    logger.error(`Upstream call failed: ${err.message}`);
    return new Response(JSON.stringify({ error: { message: "upstream failure" } }), { status: 502 });
  }

  // 必须在此环节拦截上游错误，透传给下游，防止下游逻辑进入流处理导致挂起
  if (!fetchRes.ok) {
    const errorBody = await fetchRes.text();
    logger.error(`Upstream error (Status ${fetchRes.status}): ${errorBody}`);
    return new Response(errorBody, { 
       status: fetchRes.status, 
       headers: { "Content-Type": "application/json" } 
    });
  }

  const hasXMLPlugin = modelConf.plugins.some(p => p === "xml-tool-call" || p === "xml_toolcall");
  const requestId = `msg_${Date.now()}`;
  
  // 5. 使用异步生成器构建转译流 (Zero-Latency)
  const stream = new ReadableStream({
    async start(controller) {
      if (!fetchRes.body) {
        controller.close();
        return;
      }

      const reader = fetchRes.body.getReader();
      const lexer = new XMLStreamLexer();
      const translator = new OpenAIToAnthropicTranslator(requestId, requestedModel, body.tools, toolMapping);
      const decoder = new TextDecoder();
      
      // 首先发射 Anthropic 协议要求的 message_start 事件
      controller.enqueue(translator.start());

      let inNativeToolCall = false;
      let lineBuffer = ""; // 用于处理跨包的 SSE 分片

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunkStr = decoder.decode(value, { stream: true });
          const combined = lineBuffer + chunkStr;
          const lines = combined.split("\n");
          
          // 最后一行可能是不完整的，留到下一次处理
          lineBuffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;
            const dataStr = trimmed.substring(6);
            if (dataStr === "[DONE]") {
               lineBuffer = ""; // 彻底完成
               break;
            }

            try {
              const d = JSON.parse(dataStr);
              
              // 场景 A: 处理上游返回的原生工具调用（OpenAI 风格）
              if (d.choices?.[0]?.delta?.tool_calls) {
                inNativeToolCall = true;
                const tc = d.choices[0].delta.tool_calls[0];
                if (tc.id) {
                    for (const c of translator.process({ 
                      type: "tool_call_start", 
                      id: tc.id, 
                      name: tc.function?.name || "", 
                      index: tc.index || 0 
                    })) { 
                      if (process.env.PROTOFLUX_DEBUG) logger.debug(`[Outgoing] ${new TextDecoder().decode(c)}`);
                      controller.enqueue(c); 
                    }
                }
                if (tc.function?.arguments) {
                    for (const c of translator.process({ 
                      type: "tool_call_delta", 
                      id: "", 
                      text: tc.function.arguments 
                    })) { 
                      if (process.env.PROTOFLUX_DEBUG) logger.debug(`[Outgoing] ${new TextDecoder().decode(c)}`);
                      controller.enqueue(c); 
                    }
                }
              } 
              // 场景 B: 处理普通文本内容，并尝试从中通过 Lexer 提取 XML 工具调用
              else if (d.choices?.[0]?.delta?.content) {
                const content = d.choices[0].delta.content;
                const lexerResults = hasXMLPlugin ? lexer.process(content) : [{ type: "text", text: content } as const];
                for (const res of lexerResults) {
                  for (const c of translator.process(res)) {
                    if (process.env.PROTOFLUX_DEBUG) {
                      logger.debug(`[Outgoing] ${new TextDecoder().decode(c)}`);
                    }
                    controller.enqueue(c);
                  }
                }
              }

              // 场景 C: 检测原生工具调用是否结束
              if (d.choices?.[0]?.finish_reason === "tool_calls" && inNativeToolCall) {
                for (const c of translator.process({ type: "tool_call_stop", id: "" })) {
                  if (process.env.PROTOFLUX_DEBUG) logger.debug(`[Outgoing] ${new TextDecoder().decode(c)}`);
                  controller.enqueue(c);
                }
                inNativeToolCall = false;
              }
            } catch (e) {
              if (process.env.PROTOFLUX_DEBUG) logger.error(`[Internal] JSON parse failed for line: ${line}`);
              continue;
            }
          }
        }

        // 处理最后残留的 lineBuffer（如果没有以 \n 结尾）
        if (lineBuffer.trim()) {
           const trimmed = lineBuffer.trim();
           if (trimmed.startsWith("data: ")) {
              const dataStr = trimmed.substring(6);
              if (dataStr !== "[DONE]") {
                try {
                  const d = JSON.parse(dataStr);
                  // 同上逻辑 (简化处理，通常末尾是 [DONE])
                  if (d.choices?.[0]?.delta?.content) {
                    const lexerRes: LexerResult[] = hasXMLPlugin ? lexer.process(d.choices[0].delta.content) : [{ type: "text", text: d.choices[0].delta.content }];
                    for (const res of lexerRes) {
                      for (const c of translator.process(res)) { controller.enqueue(c); }
                    }
                  }
                } catch(e) {}
              }
           }
        }

        // 刷新 Lexer 和 Translator 的缓冲区
        for (const res of lexer.flush()) {
          for (const c of translator.process(res)) {
            if (process.env.PROTOFLUX_DEBUG) {
              logger.debug(`[Outgoing] ${new TextDecoder().decode(c)}`);
            }
            controller.enqueue(c);
          }
        }
        
        // 发送最后的 message_stop 等结束事件
        for (const c of translator.flush()) {
          if (process.env.PROTOFLUX_DEBUG) {
            logger.debug(`[Outgoing] ${new TextDecoder().decode(c)}`);
          }
          controller.enqueue(c);
        }
      } catch (err) {
        logger.error(`Stream processing error: ${err}`);
      } finally {
        controller.close();
      }
    }
  });

  // 设置 SSE 响应头，禁用缓存并确保实时传输
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no" // 告诉 nginx 等代理服务器不要开启缓冲
    }
  });
}
