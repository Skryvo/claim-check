import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createChecker, createServer } from "../dist/index.js";
import { answers, cleanEnv, modelServer, pages, root, scriptedModel } from "./helpers.mjs";

async function stdioClient(env) {
  const client = new Client({ name: "claim-check-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist/cli.js"), "mcp"], env: cleanEnv(env) }));
  return client;
}

test("over stdio a client completes the handshake and lists three described, read-only tools", async () => {
  const client = await stdioClient({});
  try {
    assert.equal(client.getServerVersion()?.name, "claim-check");
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["check_claim", "check_text", "check_url"]);
    for (const tool of tools) {
      assert.ok(tool.description.length > 100, `${tool.name} is described`);
      assert.match(tool.description, /quoted from a page that was fetched/);
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(tool.outputSchema?.properties?.claims, `${tool.name} declares its output`);
      assert.equal(tool.annotations?.readOnlyHint, true);
    }
    const text = tools.find((t) => t.name === "check_text");
    assert.deepEqual(text.inputSchema.required, ["text"]);

    const unset = await client.callTool({ name: "check_text", arguments: { text: "Sales grew 40% in 2024." } });
    assert.equal(unset.isError, true);
    assert.match(unset.content[0].text, /No model is set/);
  } finally {
    await client.close();
  }
});

test("over stdio check_text runs on the configured model and returns the report as structured content", async () => {
  const model = await modelServer(answers([{ quote: "Sales grew 40% in 2024" }]));
  const client = await stdioClient({ CLAIM_CHECK_BASE_URL: model.baseUrl, CLAIM_CHECK_MODEL: "local-test" });
  try {
    const result = await client.callTool({ name: "check_text", arguments: { text: "Sales grew 40% in 2024." } });
    assert.ok(!result.isError, JSON.stringify(result.content));
    assert.equal(result.structuredContent.claims[0].verdict, "no_source_found");
    assert.equal(result.structuredContent.model, "local-test");
    assert.match(result.content[0].text, /1 claim: 1 no source found/);

    const rejected = await client.callTool({ name: "check_url", arguments: { url: "ftp://files.example/report" } });
    assert.equal(rejected.isError, true);
  } finally {
    await client.close();
    await model.close();
  }
});

test("check_claim checks one claim against the sources given", async () => {
  const model = scriptedModel(
    answers([{ quote: "The tower was built in 1899.", kind: "date" }], () => ({
      verdict: "contradicted",
      passage: "P1",
      quote: "built from 1887 to 1889",
      why: "The page gives 1887 to 1889.",
    })),
  );
  const fetchText = pages({ "https://tower.example/": "<p>The tower was built from 1887 to 1889 as the entrance arch to the fair, and it still stands on the Champ de Mars today.</p>" });
  const server = createServer(() => createChecker({ model, fetchText, maxClaims: 1 }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claim-check-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: "check_claim", arguments: { claim: "The tower was built in 1899.", sources: ["https://tower.example/"] } });
    const [claim] = result.structuredContent.claims;
    assert.equal(claim.verdict, "contradicted");
    assert.equal(claim.source.url, "https://tower.example/");
    assert.equal(claim.source.quote, "built from 1887 to 1889");
  } finally {
    await client.close();
  }
});
