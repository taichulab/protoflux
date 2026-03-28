import { type ParsedToolCall, type LexerResult, extractToolArguments } from "../plugins/xml-tool-call-stream.ts";
import { logger } from "../utils/logger.ts";

/**
 * 将 OpenAI 兼容的 SSE 事件转换为 Anthropic (Claude) SSE 事件的转译器。
 */
export class OpenAIToAnthropicTranslator {
  private requestId: string;
  private model: string;
  private textBlockIdx = 0;
  private thoughtBlockIdx = -1; // 初始化为 -1，表示尚未开启
  private currentBlockIdx = 0;  // 当前正在使用的 content_block 索引

  private hasSentTextStart = false;
  private hasSentThoughtStart = false;
  private textEncoder = new TextEncoder();
  
  private currentToolCallId = "";
  private currentToolName = "";
  private currentToolArgsBuffer = "";
  private tools?: any[];
  private toolMapping?: Record<string, string>; // { "SimplifiedName": "OriginalName" }

  constructor(requestId: string, model: string, tools?: any[], toolMapping?: Record<string, string>) {
    this.requestId = requestId;
    this.model = model;
    this.tools = tools;
    this.toolMapping = toolMapping;
  }

  private makeSSE(event: string, data: any): Uint8Array {
    return this.textEncoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  public start(): Uint8Array {
    return this.makeSSE("message_start", {
      type: "message_start",
      message: {
        id: this.requestId,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
  }

  /**
   * 还原/治愈工具名：
   * 1. 优先使用入站重写时建立的工具映射表 (Registry)
   * 2. 备选方案：尝试模糊匹配
   */
  private resolveToolName(name: string): string {
    // 场景 A: 如果存在入站建立的确定性映射表，直接还原
    if (this.toolMapping && this.toolMapping[name]) {
      return this.toolMapping[name];
    }

    if (!this.tools || this.tools.length === 0) return name;
    
    // 场景 B: 容错处理 (Case-insensitive match or MCP Suffix)
    const lowerName = name.toLowerCase();
    
    const exactMatch = this.tools.find(t => t.name.toLowerCase() === lowerName);
    if (exactMatch) return exactMatch.name;

    const mcpMatch = this.tools.find(t => t.name.endsWith("__" + name) || t.name.toLowerCase().endsWith("__" + lowerName));
    if (mcpMatch) return mcpMatch.name;

    return name;
  }

  public process(chunk: LexerResult): Uint8Array[] {
    const results: Uint8Array[] = [];
    
    if (chunk.type === "text") {
      if (!chunk.text) return results;
      this.ensureThoughtStop(results);
      
      if (!this.hasSentTextStart) {
        results.push(this.makeSSE("content_block_start", {
          type: "content_block_start",
          index: this.currentBlockIdx,
          content_block: { type: "text", text: "" }
        }));
        this.hasSentTextStart = true;
      }
      results.push(this.makeSSE("content_block_delta", {
        type: "content_block_delta",
        index: this.currentBlockIdx,
        delta: { type: "text_delta", text: chunk.text }
      }));
    } else if (chunk.type === "thought") {
      if (!chunk.text) return results;
      this.ensureTextStop(results);

      if (!this.hasSentThoughtStart) {
        results.push(this.makeSSE("content_block_start", {
          type: "content_block_start",
          index: this.currentBlockIdx,
          content_block: { type: "text", text: "" } // 目前主要还是通过 text 块来显示 thought
        }));
        this.hasSentThoughtStart = true;
      }
      results.push(this.makeSSE("content_block_delta", {
        type: "content_block_delta",
        index: this.currentBlockIdx,
        delta: { type: "text_delta", text: chunk.text }
      }));
    } else if (chunk.type === "tool_call_start") {
      this.ensureTextStop(results);
      this.ensureThoughtStop(results);
      
      this.currentToolCallId = chunk.id;
      this.currentToolName = this.resolveToolName(chunk.name);
      this.currentToolArgsBuffer = "";
      
      results.push(this.makeSSE("content_block_start", {
        type: "content_block_start",
        index: this.currentBlockIdx,
        content_block: {
          type: "tool_use",
          id: chunk.id,
          name: this.currentToolName,
          input: {}
        }
      }));
    } else if (chunk.type === "tool_call_delta") {
      this.currentToolArgsBuffer += chunk.text;
    } else if (chunk.type === "tool_call_stop") {
      let argsObj = {};
      try {
         const trimmed = this.currentToolArgsBuffer.trim();
         if (trimmed.startsWith("{") && (trimmed.endsWith("}") || trimmed.includes("}"))) {
            const start = trimmed.indexOf("{");
            const end = trimmed.lastIndexOf("}");
            if (start !== -1 && end !== -1) {
                argsObj = JSON.parse(trimmed.substring(start, end + 1));
            } else {
                argsObj = extractToolArguments(this.currentToolArgsBuffer, this.currentToolName, this.tools);
            }
         } else {
            argsObj = extractToolArguments(this.currentToolArgsBuffer, this.currentToolName, this.tools);
         }
      } catch (e) {
         argsObj = extractToolArguments(this.currentToolArgsBuffer, this.currentToolName, this.tools);
      }
      
      results.push(this.makeSSE("content_block_delta", {
        type: "content_block_delta",
        index: this.currentBlockIdx,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(argsObj)
        }
      }));

      results.push(this.makeSSE("content_block_stop", {
        type: "content_block_stop",
        index: this.currentBlockIdx
      }));
      
      this.currentBlockIdx++;
      this.currentToolCallId = "";
    }
    
    return results;
  }

  private ensureTextStop(results: Uint8Array[]) {
    if (this.hasSentTextStart) {
      results.push(this.makeSSE("content_block_stop", {
        type: "content_block_stop",
        index: this.currentBlockIdx
      }));
      this.hasSentTextStart = false;
      this.currentBlockIdx++;
    }
  }

  private ensureThoughtStop(results: Uint8Array[]) {
    if (this.hasSentThoughtStart) {
      results.push(this.makeSSE("content_block_stop", {
        type: "content_block_stop",
        index: this.currentBlockIdx
      }));
      this.hasSentThoughtStart = false;
      this.currentBlockIdx++;
    }
  }

  public flush(): Uint8Array[] {
    const results: Uint8Array[] = [];
    this.ensureTextStop(results);
    this.ensureThoughtStop(results);
    
    const isToolCall = this.currentBlockIdx > 0;
    results.push(this.makeSSE("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: isToolCall ? "tool_use" : "end_turn",
        stop_sequence: null,
      },
      usage: { output_tokens: 0 }
    }));
    results.push(this.makeSSE("message_stop", { type: "message_stop" }));
    return results;
  }
}
