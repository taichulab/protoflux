import { extractToolArguments } from "../src/plugins/xml-tool-call-stream.ts";

const tools = [
  {
    name: "Glob",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The glob pattern" },
        path: { type: "string", description: "The path" }
      },
      required: ["pattern"]
    }
  }
];

function test(argsRaw: string, expected: any) {
  const result = extractToolArguments(argsRaw, "Glob", tools);
  console.log(`Input: [${argsRaw.replace(/\n/g, "\\n")}]`);
  console.log(`Result: ${JSON.stringify(result)}`);
  const ok = JSON.stringify(result) === JSON.stringify(expected);
  console.log(ok ? "✅ PASS" : "❌ FAIL");
  if (!ok) {
     console.log(`Expected: ${JSON.stringify(expected)}`);
     process.exit(1);
  }
}

console.log("--- Testing Joint Key-Value ---");
test("pattern**/README*", { pattern: "**/README*" });
test("\npattern**/README*\n", { pattern: "**/README*" });

console.log("\n--- Testing Multiple Parameters (Mixed) ---");
test("path: . pattern: *.ts", { path: ".", pattern: "*.ts" });

console.log("\n--- Testing Single String (Positional) ---");
test("**/README*", { pattern: "**/README*" });

console.log("\n--- All Tests Passed ---");
