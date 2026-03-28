import Anthropic from "@anthropic-ai/sdk";
import type { UpstreamConfig } from "../config/types.ts";
import { logger } from "../utils/logger.ts";

/**
 * 针对 Anthropic 官方 SDK 的对冲 Provider。
 * 处理 Messages 接口的原生流式与非流式调用。
 * 
 * @param upstream 上游配置
 * @param body 映射后的 Anthropic 格式请求体
 * @param _req 原始请求
 */
export async function handleAnthropic(upstream: UpstreamConfig, body: any, _req: Request): Promise<Response> {
  const client = new Anthropic({
    apiKey: upstream.apiKey || "",
    baseURL: upstream.baseUrl || undefined, // 默认为官方 URL
  });

  const modelId = body.model;
  const isStream = !!body.stream;

  logger.info(`Anthropic SDK: Calling model [${modelId}] (stream=${isStream})`);

  try {
    if (isStream) {
       // 流式处理：Anthropic SDK 返回一个能够由 async generator 消费的 stream
       const stream = await client.messages.create({
         ...body,
         stream: true,
       });

       const encoder = new TextEncoder();
       const readable = new ReadableStream({
         async start(controller) {
           try {
             // 逐个处理 Anthropic SSE 事件
             for await (const event of stream as any) {
                // 将 SDK 事件对象直接映射为 data: JSON
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
             }
             controller.enqueue(encoder.encode("data: [DONE]\n\n"));
           } catch (e: any) {
             logger.error(`Anthropic SDK stream error: ${e?.message || e}`);
             controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: { message: e?.message || "Stream error" } })}\n\n`));
           } finally {
             controller.close();
           }
         },
       });

       return new Response(readable, {
         headers: {
           "Content-Type": "text/event-stream",
           "Cache-Control": "no-cache",
           "Connection": "keep-alive",
         },
       });
    } else {
       // 非流式处理
       const response = await client.messages.create({
         ...body,
         stream: false,
       });
       return new Response(JSON.stringify(response), {
         headers: { "Content-Type": "application/json" },
       });
    }
  } catch (err: any) {
    logger.error(`Anthropic SDK error: ${err?.message || err}`);
    return new Response(JSON.stringify({
      error: {
        message: err?.message || "Internal Anthropic Provider Error",
        type: "anthropic_sdk_error"
      }
    }), { status: err?.status || 500 });
  }
}
