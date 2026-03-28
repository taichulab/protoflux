import { describe, expect, test } from "bun:test";
import { OpenAIToAnthropicTranslator } from "../src/protocols/openai-to-anthropic-stream.ts";

describe("OpenAIToAnthropicTranslator", () => {
  const model = "claude-3-sonnet";
  const requestId = "req_123";

  /**
   * Helper to extract the JSON data from a single SSE-formatted Uint8Array chunk.
   */
  const extractData = (chunk: Uint8Array) => {
    const str = new TextDecoder().decode(chunk);
    const lines = str.split("\n");
    const dataLine = lines.find(l => l.startsWith("data: "));
    if (!dataLine) return null;
    return JSON.parse(dataLine.substring(6));
  };

  test("should translate text content correctly", () => {
    const translator = new OpenAIToAnthropicTranslator(requestId, model);
    translator.start();
    const resultChucks = translator.process({ type: "text", text: "Hello" });

    expect(resultChucks).toHaveLength(2); // content_block_start and content_block_delta
    const data = extractData(resultChucks[1]!); // Fixed: Added non-null assertion
    expect(data?.type).toBe("content_block_delta");
    expect(data?.delta?.text).toBe("Hello");
  });

  test("should translate partial tool call start/delta/stop into Anthropic events", () => {
    const translator = new OpenAIToAnthropicTranslator(requestId, model);
    
    // 1. Tool Call Start
    const startChunks = translator.process({ 
      type: "tool_call_start", 
      id: "call_1", 
      name: "get_weather",
      index: 0 
    });
    expect(startChunks.length).toBeGreaterThan(0);
    const startData = extractData(startChunks[0]!); // Fixed: Added non-null assertion
    expect(startData?.content_block?.type).toBe("tool_use");
    expect(startData?.content_block?.name).toBe("get_weather");

    // 2. Tool Call Delta
    const deltaChunks = translator.process({ 
      type: "tool_call_delta", 
      id: "call_1", 
      text: 'location="New York"' 
    });
    expect(deltaChunks).toHaveLength(0); // Arguments are buffered internally

    // 3. Tool Call Stop
    const stopChunks = translator.process({ type: "tool_call_stop", id: "call_1" });
    expect(stopChunks).toHaveLength(2); // input_json_delta and content_block_stop
    
    const deltaData = extractData(stopChunks[0]!); // Fixed: Added non-null assertion
    expect(deltaData?.delta?.type).toBe("input_json_delta");
    expect(deltaData?.delta?.partial_json).toBe('{"location":"New York"}');
  });

  test("should parse JSON arguments correctly if detected", () => {
     const translator = new OpenAIToAnthropicTranslator(requestId, model);
     translator.process({ type: "tool_call_start", id: "call_1", name: "Read", index: 0 });
     translator.process({ type: "tool_call_delta", id: "call_1", text: '{"file_path": "foo.py"}' });
     
     const stopChunks = translator.process({ type: "tool_call_stop", id: "call_1" });
     expect(stopChunks.length).toBeGreaterThan(0);
     const deltaData = extractData(stopChunks[0]!); // Fixed: Added non-null assertion
     expect(deltaData?.delta?.partial_json).toBe('{"file_path":"foo.py"}');
  });
});
