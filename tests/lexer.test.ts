import { test, expect } from "bun:test";
import { XMLStreamLexer, extractToolArguments } from "../src/plugins/xml-tool-call-stream.ts";

test("XMLStreamLexer - parse Claude Code style tool call without parens", () => {
    const lexer = new XMLStreamLexer();
    
    // Simulate Claude Code streaming
    const stream = [
        "Here is the tool call:\n",
        "<tool_",
        "call>\n",
        "Read\n",
        "file_path: AGENTS.md\n",
        "</tool",
        "_call>"
    ];

    const allResults = [];
    for (const chunk of stream) {
        allResults.push(...lexer.process(chunk));
    }
    
    expect(allResults.some(r => r.type === "tool_call_start" && r.name === "Read")).toBe(true);
    expect(allResults.some(r => r.type === "tool_call_stop")).toBe(true);
    
    // Extract the raw text from tool_call_delta
    const deltas = allResults.filter(r => r.type === "tool_call_delta").map(r => r.text).join("");
    expect(deltas.includes("file_path: AGENTS.md")).toBe(true);
    
    // Check if extractToolArguments can decode the yaml-like parameter format
    const parsedArgs = extractToolArguments(deltas, "Read");
    expect(parsedArgs["file_path"]).toBe("AGENTS.md");
});

test("XMLStreamLexer - parse unclosed continuous GLM style tool calls", () => {
    const lexer = new XMLStreamLexer();
    
    // Simulate GLM continuous missing closing tags
    const stream = [
        "First call:<tool_call>Read\nfile_path: foo.txt\nMore text..",
        "<tool_call>Bash\ncommand: ls -la\nEnd call"
    ];

    const allResults = [];
    for (const chunk of stream) {
        allResults.push(...lexer.process(chunk));
    }
    allResults.push(...lexer.flush());
    
    // Should detect two start calls
    const starts = allResults.filter(r => r.type === "tool_call_start");
    expect(starts.length).toBe(2);
    expect(starts[0].name).toBe("Read");
    expect(starts[1].name).toBe("Bash");
    
    // Should detect two stops
    const stops = allResults.filter(r => r.type === "tool_call_stop");
    expect(stops.length).toBe(2);
});

test("XMLStreamLexer - fallback JSON payload tool arguments", () => {
    const parsedArgs = extractToolArguments(`{\n  "command": "ls -la",\n  "timeout": 30\n}`, "Bash");
    expect(parsedArgs["command"]).toBe("ls -la");
    expect(parsedArgs["timeout"]).toBe(30);
});

test("XMLStreamLexer - handle normal xml style tool arguments", () => {
    const parsedArgs = extractToolArguments(`file_path="src/index.ts", line_number=45`, "Read");
    expect(parsedArgs["file_path"]).toBe("src/index.ts");
    expect(parsedArgs["line_number"]).toBe(45);
});
