import OpenAI from "openai";
import type { UpstreamConfig } from "../config/types.ts";
import { logger } from "../utils/logger.ts";

function createClient(upstream: UpstreamConfig) {
  return new OpenAI({
    apiKey: upstream.apiKey || "",
    baseURL: upstream.baseUrl,
  });
}

/**
 * 对应 `openai-completions` 协议：
 * 处理传统的 OpenAI Text Completions (client.completions.create)
 */
export async function handleOpenAICompletions(upstream: UpstreamConfig, body: any, _req: Request): Promise<Response> {
  const client = createClient(upstream);
  const modelId = body.model;
  const isStream = !!body.stream;

  logger.info(`OpenAI SDK [Text Completions]: Calling model [${modelId}] via [${upstream.baseUrl}] (stream=${isStream})`);

  try {
    // 粗略将 messages 转换为 prompt，因为传统的 completions.create 需要 prompt
    let prompt = "";
    if (body.messages && Array.isArray(body.messages)) {
      prompt = body.messages.map((m: any) => `${m.role}: ${m.content}`).join("\n") + "\nassistant: ";
    } else if (body.prompt) {
      prompt = body.prompt;
    }

    const { messages, ...restBody } = body;

    if (isStream) {
      const stream = await client.completions.create({
        ...restBody,
        prompt,
        stream: true,
      });

      const encoder = new TextEncoder();
      const generatedId = `chatcmpl-${Date.now()}`;
      const generatedCreated = Math.floor(Date.now() / 1000);

      const readable = new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of stream as any) {
              // chunk 是老的 text_completion 的结构，转化为 chat.completion.chunk
              if (chunk.choices && chunk.choices[0]) {
                 const textChunk = chunk.choices[0].text || "";
                 const finishReason = chunk.choices[0].finish_reason || null;
                 
                 const stdChunk = {
                    id: chunk.id || generatedId,
                    object: "chat.completion.chunk",
                    created: chunk.created || generatedCreated,
                    model: chunk.model || modelId,
                    choices: [
                        {
                            index: chunk.choices[0].index || 0,
                            delta: textChunk ? { content: textChunk } : {},
                            logprobs: null,
                            finish_reason: finishReason
                        }
                    ]
                 };
                 controller.enqueue(encoder.encode(`data: ${JSON.stringify(stdChunk)}\n\n`));
              }
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          } catch (e: any) {
            logger.error(`OpenAI SDK stream error: ${e?.message || e}`);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: e?.message || "Stream error" } })}\n\n`));
          } finally {
            controller.close();
          }
        },
      });

      return new Response(readable, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
      });
    } else {
      const response: any = await client.completions.create({
        ...restBody,
        prompt,
        stream: false,
      });
      
      const standardResponse = {
         id: response.id || `chatcmpl-${Date.now()}`,
         object: "chat.completion",
         created: response.created || Math.floor(Date.now() / 1000),
         model: response.model || modelId,
         choices: [
            {
                index: 0,
                message: {
                    role: "assistant",
                    content: response.choices?.[0]?.text || ""
                },
                finish_reason: response.choices?.[0]?.finish_reason || "stop"
            }
         ],
         usage: response.usage || null
      };
      return new Response(JSON.stringify(standardResponse), {
        headers: { "Content-Type": "application/json" },
      });
    }
  } catch (err: any) {
    logger.error(`OpenAI SDK error: ${err?.message || err}`);
    return new Response(JSON.stringify({ error: { message: err?.message || "Internal OpenAI Provider Error", type: "openai_sdk_error" } }), { status: err?.status || 500 });
  }
}

/**
 * 对应 `openai` 协议：
 * 处理现代的 OpenAI Chat Completions (client.chat.completions.create)
 */
export async function handleOpenAI(upstream: UpstreamConfig, body: any, _req: Request): Promise<Response> {
  const client = createClient(upstream);
  const modelId = body.model;
  const isStream = !!body.stream;

  logger.info(`OpenAI SDK [Chat Completions]: Calling model [${modelId}] via [${upstream.baseUrl}] (stream=${isStream})`);

  try {
    if (isStream) {
      const stream = await client.chat.completions.create({
        ...body,
        stream: true,
      });

      const encoder = new TextEncoder();
      const readable = new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of stream as any) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          } catch (e: any) {
            logger.error(`OpenAI SDK stream error: ${e?.message || e}`);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: e?.message || "Stream error" } })}\n\n`));
          } finally {
            controller.close();
          }
        },
      });

      return new Response(readable, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
      });
    } else {
      const response = await client.chat.completions.create({
        ...body,
        stream: false,
      });
      return new Response(JSON.stringify(response), {
        headers: { "Content-Type": "application/json" },
      });
    }
  } catch (err: any) {
    logger.error(`OpenAI SDK error: ${err?.message || err}`);
    return new Response(JSON.stringify({ error: { message: err?.message || "Internal OpenAI Provider Error", type: "openai_sdk_error" } }), { status: err?.status || 500 });
  }
}

/**
 * 对应 `openai-response` 协议：
 * 处理阿里百炼的 Responses API (client.responses.create)
 */
export async function handleOpenAIResponse(upstream: UpstreamConfig, body: any, _req: Request): Promise<Response> {
  const client = createClient(upstream);
  const modelId = body.model;
  const isStream = !!body.stream;

  logger.info(`OpenAI SDK [Responses]: Calling model [${modelId}] via [${upstream.baseUrl}] (stream=${isStream})`);

  try {
    // 将传统的 messages 映射到 input
    const input = body.messages || body.input;
    const { messages, ...restBody } = body;

    // 为了使用 SSE 转译，我们需要自己生成 chunk id 和 created
    const generatedId = `chatcmpl-${crypto.randomUUID()}`;
    const generatedCreated = Math.floor(Date.now() / 1000);

    if (isStream) {
      // Responses stream
      const stream = await client.responses.create({
        ...restBody,
        input,
        stream: true,
      });

      const encoder = new TextEncoder();
      const readable = new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of stream as any) {
              const eventType = chunk.type;
              logger.debug(`Responses SDK chunk: ${JSON.stringify(chunk)}`);
              
              if (eventType === "error" || eventType === "response.failed") {
                const errMsg = chunk.error?.message || chunk.response?.error?.message || "Responses API error";
                throw new Error(errMsg);
              } 
              
              // 兼容 ResponseTextDeltaEvent
              if (eventType === "text.delta") {
                const stdChunk = {
                  id: generatedId,
                  object: "chat.completion.chunk",
                  created: generatedCreated,
                  model: modelId,
                  choices: [
                      {
                          index: 0,
                          delta: {
                              content: chunk.delta || ""
                          },
                          logprobs: null,
                          finish_reason: null
                      }
                  ]
               };
               controller.enqueue(encoder.encode(`data: ${JSON.stringify(stdChunk)}\n\n`));
              }
            }
            
            // 补一个 [DONE] 前的结束块
            const doneChunk = {
              id: generatedId,
              object: "chat.completion.chunk",
              created: generatedCreated,
              model: modelId,
              choices: [
                  {
                      index: 0,
                      delta: {},
                      logprobs: null,
                      finish_reason: "stop"
                  }
              ]
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(doneChunk)}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            
          } catch (e: any) {
            logger.error(`OpenAI SDK stream error: ${e?.message || e}`);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: e?.message || "Stream error" } })}\n\n`));
          } finally {
            controller.close();
          }
        },
      });

      return new Response(readable, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
      });
    } else {
      const response: any = await client.responses.create({
        ...restBody,
        input,
        stream: false,
      });
      
      // 不管是阿里百炼还是官方，我们要保证返回的是 Chat Completion Format
      const standardResponse = {
         id: response.id || generatedId,
         object: "chat.completion",
         created: response.created_at || generatedCreated,
         model: response.model || modelId,
         choices: [
            {
                index: 0,
                message: {
                    role: "assistant",
                    content: response.output_text || ""
                },
                finish_reason: "stop"
            }
         ],
         usage: response.usage || null
      };

      return new Response(JSON.stringify(standardResponse), {
        headers: { "Content-Type": "application/json" },
      });
    }
  } catch (err: any) {
    logger.error(`OpenAI SDK error: ${err?.message || err}`);
    return new Response(JSON.stringify({ error: { message: err?.message || "Internal OpenAI Provider Error", type: "openai_sdk_error" } }), { status: err?.status || 500 });
  }
}
