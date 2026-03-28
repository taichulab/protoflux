import { logger } from "../utils/logger.ts";

/**
 * 表示一个已完整解析的工具调用对象。
 */
export interface ParsedToolCall {
  index: number; // 工具调用在当前对话序列中的索引
  id: string;    // 工具调用的唯一标识符
  name: string;  // 被调用的工具名称
  args: any;     // 解析后的工具参数（通常为 JSON 对象）
}

/**
 * XMLStreamLexer 在处理流式文本时触发的事件类型。
 */
export type LexerResult = 
  | { type: "text", text: string }                        // 普通的助手回复文本内容
  | { type: "thought", id: string, text: string }         // 思考过程 (Thinking Process)
  | { type: "tool_call_start", id: string, name: string, index: number } // 检测到 <tool_call>Name( 的开始
  | { type: "tool_call_delta", id: string, text: string }  // 工具调用中的局部参数内容
  | { type: "tool_call_stop", id: string }                // 检测到 </tool_call> 闭合标签
  | { type: "tool_call", t: ParsedToolCall };              // 完整解析后的工具调用（用于非流式或兼容性场景）

/**
 * 从原始字符串中鲁棒地提取工具参数。
 */
export function extractToolArguments(argsRaw: string, toolName?: string, tools?: any[]): Record<string, any> {
  const trimmedArgs = argsRaw.trim();
  if ((trimmedArgs.startsWith("{") && trimmedArgs.endsWith("}")) || (trimmedArgs.startsWith("[") && trimmedArgs.endsWith("]"))) {
    try { return JSON.parse(trimmedArgs); } catch(e) {}
  }

  const argsObj: Record<string, any> = {};
  let i = 0;
  const n = argsRaw.length;
  let posIdx = 0;

  function skipWs() {
    while (i < n && (argsRaw[i] === " " || argsRaw[i] === "\t" || argsRaw[i] === "\n" || argsRaw[i] === "\r" || argsRaw[i] === ",")) i++;
  }

  while (i < n) {
    skipWs();
    if (i >= n) break;

    const startI = i;
    let tempI = i;
    while (tempI < n && /[\w_]/.test(argsRaw[tempI]!)) tempI++;
    let peekI = tempI;
    while (peekI < n && (argsRaw[peekI] === " " || argsRaw[peekI] === "\t")) peekI++;
    
    let key = "";
    let val: any = "";
    let isYamlStyle = false;
    let fallbackToPositional = false;
    
    if (peekI < n && (argsRaw[peekI] === "=" || argsRaw[peekI] === ":")) {
      isYamlStyle = argsRaw[peekI] === ":";
      key = argsRaw.substring(i, tempI).trim();
      i = peekI + 1;
      skipWs();
    } else {
      fallbackToPositional = true;
      key = `arg${posIdx}`;
      posIdx++;
    }

    if (i >= n) break;
    const firstChar = argsRaw[i];
    if (!fallbackToPositional && (firstChar === '"' || firstChar === "'")) {
      const quoteChar = firstChar;
      const sub3 = argsRaw.substring(i, i + 3);
      let isTriple = sub3 === quoteChar.repeat(3);
      
      if (isTriple) {
        i += 3;
        let valStart = i;
        while (i < n) {
          if (argsRaw.substring(i, i + 3) === quoteChar.repeat(3) && (i === 0 || argsRaw[i - 1] !== '\\')) {
            val = argsRaw.substring(valStart, i);
            i += 3;
            break;
          }
          i++;
        }
      } else {
        i++;
        let valStart = i;
        while (i < n) {
          if (argsRaw[i] === quoteChar && (i === 0 || argsRaw[i - 1] !== '\\')) {
            val = argsRaw.substring(valStart, i);
            i++;
            break;
          }
          i++;
        }
      }
      if (typeof val === "string") {
          val = val.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
      }
    } else {
      let valStart = i;
      if (isYamlStyle) {
        while (i < n && argsRaw[i] !== "\n" && argsRaw[i] !== "\r") i++;
      } else {
        while (i < n && argsRaw[i] !== "," && !/[\s]/.test(argsRaw[i]!)) i++;
      }
      val = argsRaw.substring(valStart, i).trim();
      
      if (/^-?\d+(\.\d+)?$/.test(val)) val = Number(val);
      else if (val === "true") val = true;
      else if (val === "false") val = false;
      else if (val === "None" || val === "null") val = null;
    }

    if (toolName && tools && tools.length > 0) {
      const targetTool = tools.find(t => t.name === toolName);
      if (targetTool?.input_schema?.properties) {
          const props = Object.keys(targetTool.input_schema.properties);
          const requiredProps = targetTool.input_schema.required || [];

          if (fallbackToPositional && typeof val === "string" && val.length > 2) {
             const matchedProp = props.find(p => val.startsWith(p) && val.length > p.length);
             if (matchedProp) {
                const residue = val.substring(matchedProp.length).replace(/^[:=\s]+/, "");
                key = matchedProp;
                val = residue;
                fallbackToPositional = false;
             }
          }

          if (fallbackToPositional) {
             if (props.length === 1) {
                 key = props[0]!;
                 posIdx--;
             } else if (requiredProps.length === 1) {
                 key = requiredProps[0]!;
                 posIdx--;
             } else if (props[posIdx-1]) {
                 key = props[posIdx-1]!;
                 posIdx--;
             }
          } else {
             if (!props.includes(key)) {
                const guessed = props.find(p => p.toLowerCase().includes(key.toLowerCase()) || key.toLowerCase().includes(p.toLowerCase()));
                if (guessed) key = guessed;
             }
          }
      }
    }

    argsObj[key] = val;
  }

  if (toolName && tools && tools.length > 0) {
     const targetTool = tools.find(t => t.name === toolName);
     if (targetTool?.input_schema?.properties) {
        const allowedProps = Object.keys(targetTool.input_schema.properties);
        for (const k of Object.keys(argsObj)) {
            if (!allowedProps.includes(k)) delete argsObj[k];
        }
     }
  }

  return argsObj;
}

export class XMLStreamLexer {
  private buffer = "";
  private state: "text" | "thought" | "name" | "args" = "text";
  private toolCallIndex = 0;
  private currentToolCallId = "";
  private currentToolName = "";

  constructor() {}

  public process(chunk: string): LexerResult[] {
    const results: LexerResult[] = [];
    if (!chunk) return results;
    this.buffer += chunk;
    
    while (this.buffer.length > 0) {
      if (this.state === "text") {
        const thoughtMatch = this.buffer.match(/<(thought|thinking|thought_call)>/);
        const toolMatchIdx = this.buffer.indexOf("<tool_call>");
        
        // 优先检查哪个标签先出现
        let thoughtMatchIdx = thoughtMatch ? this.buffer.indexOf(thoughtMatch[0]!) : -1;
        
        if (thoughtMatchIdx !== -1 && (toolMatchIdx === -1 || thoughtMatchIdx < toolMatchIdx)) {
           // 进入思考状态
           if (thoughtMatchIdx > 0) results.push({ type: "text", text: this.buffer.substring(0, thoughtMatchIdx) });
           this.buffer = this.buffer.substring(thoughtMatchIdx + thoughtMatch![0]!.length);
           this.state = "thought";
           if (!this.currentToolCallId) this.currentToolCallId = `thought_${Date.now()}`;
        } else if (toolMatchIdx !== -1) {
           // 进入工具名状态
           if (toolMatchIdx > 0) results.push({ type: "text", text: this.buffer.substring(0, toolMatchIdx) });
           this.buffer = this.buffer.substring(toolMatchIdx + "<tool_call>".length);
           this.state = "name";
           this.currentToolName = "";
        } else {
           // 检查截断情况
           const possiblePartial = this.buffer.lastIndexOf("<");
           if (possiblePartial !== -1 && ("<tool_call>".startsWith(this.buffer.substring(possiblePartial)) || "<thought>".startsWith(this.buffer.substring(possiblePartial)) || "<thinking>".startsWith(this.buffer.substring(possiblePartial)))) {
              const safeText = this.buffer.substring(0, possiblePartial);
              if (safeText) results.push({ type: "text", text: safeText });
              this.buffer = this.buffer.substring(possiblePartial);
              break;
           } else {
              results.push({ type: "text", text: this.buffer });
              this.buffer = "";
           }
        }
      } else if (this.state === "thought") {
        const closeTagMatch = this.buffer.match(/<\/(thought|thinking|thought_call)>/);
        if (!closeTagMatch) {
           results.push({ type: "thought", id: this.currentToolCallId, text: this.buffer });
           this.buffer = "";
           break;
        } else {
           const endIdx = this.buffer.indexOf(closeTagMatch[0]!);
           const content = this.buffer.substring(0, endIdx);
           if (content) results.push({ type: "thought", id: this.currentToolCallId, text: content });
           this.buffer = this.buffer.substring(endIdx + closeTagMatch[0]!.length);
           this.state = "text";
        }
      } else if (this.state === "name") {
        const trimmed = this.buffer.trimStart();
        if (trimmed.length === 0) break;
        
        const nameMatch = trimmed.match(/^([A-Za-z0-9_.-]+)([\s\S])/);
        if (!nameMatch) {
           const closeTagIdx = this.buffer.indexOf("</tool_call>");
           if (closeTagIdx !== -1) {
              const possibleName = this.buffer.substring(0, closeTagIdx).trim();
              this.currentToolName = possibleName;
              this.currentToolCallId = `call_${Date.now()}_${this.toolCallIndex}`;
              results.push({ type: "tool_call_start", id: this.currentToolCallId, name: this.currentToolName, index: this.toolCallIndex++ });
              results.push({ type: "tool_call_stop", id: this.currentToolCallId });
              this.buffer = this.buffer.substring(closeTagIdx + "</tool_call>".length);
              this.state = "text";
              continue;
           }
           break;
        } else {
          this.currentToolName = nameMatch[1]!;
          this.currentToolCallId = `call_${Date.now()}_${this.toolCallIndex}`;
          results.push({ type: "tool_call_start", id: this.currentToolCallId, name: this.currentToolName, index: this.toolCallIndex++ });
          const boundaryChar = nameMatch[2]!;
          const trimOffset = this.buffer.length - trimmed.length;
          const consumeLen = trimOffset + this.currentToolName.length + (boundaryChar === "(" ? 1 : 0);
          this.buffer = this.buffer.substring(consumeLen);
          this.state = "args";
        }
      } else if (this.state === "args") {
        const closeTagIdx = this.buffer.indexOf("</tool_call>");
        const customCloseTag = this.currentToolName ? `</${this.currentToolName}>` : "";
        const customCloseIdx = customCloseTag ? this.buffer.indexOf(customCloseTag) : -1;
        const nextOpenTagIdx = this.buffer.indexOf("<tool_call>");
        
        let terminalIdx = -1;
        let isImplicitClose = false;
        let terminalLen = 0;

        if (closeTagIdx !== -1) { terminalIdx = closeTagIdx; terminalLen = "</tool_call>".length; }
        if (customCloseIdx !== -1 && (terminalIdx === -1 || customCloseIdx < terminalIdx)) { terminalIdx = customCloseIdx; terminalLen = customCloseTag.length; }
        if (nextOpenTagIdx !== -1 && (terminalIdx === -1 || nextOpenTagIdx < terminalIdx)) { terminalIdx = nextOpenTagIdx; terminalLen = 0; isImplicitClose = true; }

        if (terminalIdx === -1) {
          const possiblePartial = this.buffer.lastIndexOf("</");
          if (possiblePartial !== -1 && "</tool_call>".startsWith(this.buffer.substring(possiblePartial))) {
             const safeText = this.buffer.substring(0, possiblePartial);
             if (safeText) results.push({ type: "tool_call_delta", id: this.currentToolCallId, text: safeText });
             this.buffer = this.buffer.substring(possiblePartial);
             break;
          } else {
             results.push({ type: "tool_call_delta", id: this.currentToolCallId, text: this.buffer });
             this.buffer = "";
             break;
          }
        } else {
          let deltaArgs = this.buffer.substring(0, terminalIdx);
          if (deltaArgs) results.push({ type: "tool_call_delta", id: this.currentToolCallId, text: deltaArgs });
          results.push({ type: "tool_call_stop", id: this.currentToolCallId });
          this.buffer = this.buffer.substring(terminalIdx + terminalLen);
          this.state = "text";
        }
      }
    }
    return results;
  }

  public flush(): LexerResult[] {
    const results: LexerResult[] = [];
    if (this.state === "thought") {
       if (this.buffer) results.push({ type: "thought", id: this.currentToolCallId, text: this.buffer });
    } else if (this.state === "args") {
      if (this.buffer) results.push({ type: "tool_call_delta", id: this.currentToolCallId, text: this.buffer });
      results.push({ type: "tool_call_stop", id: this.currentToolCallId });
    } else if (this.state === "name" && this.buffer) {
      results.push({ type: "text", text: "<tool_call>" + this.buffer });
    } else if (this.state === "text" && this.buffer) {
      results.push({ type: "text", text: this.buffer });
    }
    this.buffer = "";
    this.state = "text";
    return results;
  }
}
