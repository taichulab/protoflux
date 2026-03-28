import { BedrockRuntimeClient, InvokeModelWithResponseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import type { UpstreamConfig } from "../config/types.ts";
import { logger } from "../utils/logger.ts";

/**
 * 针对 AWS Bedrock 上游的高级处理函数，使用官方 AWS SDK 进行集成。
 * 支持响应流 (Streaming) 的实时转译，将 Bedrock 的原生块事件转换为
 * 标准的 OpenAI SSE 格式，从而实现对下游 SDK 的无缝兼容。
 * 
 * @param upstream 上游配置对象（包含 Region, AccessKey, SecretKey）
 * @param body 已经按照目标格式映射好的请求体
 * @param req 原始入站请求
 */
export async function handleBedrock(upstream: UpstreamConfig, body: any, req: Request): Promise<Response> {
  const modelId = body.model;
  
  // 1. 初始化 AWS SDK 客户端
  const client = new BedrockRuntimeClient({
    region: upstream.region || "us-east-1",
    credentials: {
      accessKeyId: upstream.accessKey || "",
      secretAccessKey: upstream.secretKey || ""
    }
  });

  // 2. 构造 Bedrock 专属的 Payload 结构
  // 注意：Bedrock 上的 Claude 模型通常需要特定的 anthropic_version 和消息结构
  const bedrockInput = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: body.max_tokens || 4096,
    // 过滤掉系统消息，因为 Bedrock/Anthropic 要求系统提示词放在顶层字段
    messages: body.messages.filter((m: any) => m.role !== "system"),
    system: body.messages.find((m: any) => m.role === "system")?.content || "",
    temperature: body.temperature || 0.7,
    tools: body.tools,
    tool_choice: body.tool_choice,
  };

  const command = new InvokeModelWithResponseStreamCommand({
    contentType: "application/json",
    accept: "application/json",
    modelId: modelId,
    body: JSON.stringify(bedrockInput),
  });

  logger.info(`Bedrock: Invoking model [${modelId}] in region [${upstream.region || 'us-east-1'}]`);

  try {
    const response = await client.send(command);
    logger.info(`Bedrock: SDK response received, body exists: ${!!response.body}`);
    
    // 3. 将 AWS SDK 的异步流转换为 OpenAI 兼容的 SSE 流
    const stream = new ReadableStream({
      async start(controller) {
        if (!response.body) {
           logger.error(`Bedrock: response.body is null for model [${modelId}]`);
           controller.close();
           return;
        }

        const encoder = new TextEncoder();
        const requestId = `bedrock-${Date.now()}`;

        try {
          // 逐块处理 Bedrock 返回的二进制事件流
          for await (const chunk of response.body) {
            if (chunk.chunk?.bytes) {
               const decoded = JSON.parse(new TextDecoder().decode(chunk.chunk.bytes));
               logger.debug(`Bedrock chunk event: ${JSON.stringify(decoded)}`);
               
               // 格式 A: Anthropic 原生格式 (content_block_delta)
                if (decoded.type === "content_block_delta" && (decoded.delta?.text || decoded.delta?.thinking || decoded.delta?.thought)) {
                   const text = decoded.delta.text || decoded.delta.thinking || decoded.delta.thought;
                   controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                     id: requestId,
                     object: "chat.completion.chunk",
                     created: Math.floor(Date.now() / 1000),
                     model: modelId,
                     choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
                   })}\n\n`));
                } 
               // 格式 A: Anthropic 原生格式 (message_delta / stop)
               else if (decoded.type === "message_delta" && decoded.delta?.stop_reason) {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                    id: requestId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: modelId,
                    choices: [{ index: 0, delta: {}, finish_reason: decoded.delta.stop_reason }]
                  })}\n\n`));
               }
               // 格式 B: OpenAI 兼容格式 (choices[].delta.content 或 tool_calls) — 部分 Bedrock 模型使用此格式
               else if (decoded.choices?.[0]?.delta) {
                  const delta = decoded.choices[0].delta;
                  const finishReason = decoded.choices[0].finish_reason;
                  
                  // 透傳 delta 中的 content, tool_calls 等關鍵字段
                  if (delta.content || delta.tool_calls || finishReason) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                      id: decoded.id || requestId,
                      object: "chat.completion.chunk",
                      created: decoded.created || Math.floor(Date.now() / 1000),
                      model: modelId,
                      choices: [{ 
                        index: 0, 
                        delta: delta, // 直接透傳完整的 delta 結構，包含 content 和 tool_calls
                        finish_reason: finishReason || null 
                      }]
                    })}\n\n`));
                  }
               }
            }
          }
          // 发送符合 OpenAI 规范的结束标志
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (e: any) {
          logger.error(`Bedrock stream error: ${e?.message || e}`);
          // 将错误信息作为 SSE 事件发回，确保下游能看到而非空流
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              id: requestId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [{ index: 0, delta: { content: `[Bedrock Error: ${e?.message || 'unknown'}]` }, finish_reason: "stop" }]
            })}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          } catch (_) {}
        } finally {
          controller.close();
        }
      }
    });

    // 返回经过转译后的流式响应
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no"
      }
    });
  } catch (err: any) {
    logger.error(`Bedrock execution error: ${err?.message || err}`);
    // 返回具体的错误信息，帮助客户端定位问题（如模型 ID 无效、凭据过期等）
    return new Response(JSON.stringify({ 
      error: { 
        type: "bedrock_error",
        message: err?.message || "unknown bedrock error" 
      } 
    }), { status: err?.$metadata?.httpStatusCode || 502 });
  }
}
