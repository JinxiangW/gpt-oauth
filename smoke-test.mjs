import { createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai";

import { createSubscriptionPiProvider, gptModelCatalog, resolveOAuthAccessToken } from "./index.js";

async function main(args = process.argv.slice(2), dependencies = {}) {
  const noCall = args.includes("--no-call");
  const modelFlag = args.find((arg) => arg.startsWith("--model="));
  // Keep this default inside the installed Codex catalog; gpt-5.4 left the
  // catalog in pi-ai 0.86 and gpt-6 replaced that generation.
  const requestedModel = modelFlag?.slice("--model=".length) || "gpt-5.6-luna";
  const resolveAccess = dependencies.resolveAccess ?? resolveOAuthAccessToken;
  const createCollection = dependencies.createCollection ?? createModels;

  const catalog = gptModelCatalog();
  console.log(`catalog gpt models: ${catalog.length}`);
  for (const model of catalog) {
    console.log(`- ${model.id}: efforts=${getSupportedThinkingLevels(model).join(",")}`);
  }

  if (noCall) {
    console.log("SKIP_CALL");
    return 0;
  }

  const access = await resolveAccess(console);
  if (access === undefined) {
    console.error("NO_OAUTH_TOKEN: run dsh-openai-login first");
    return 2;
  }
  console.log("oauth access token: resolved");
  console.log("endpoint model listing: skipped (ChatGPT subscription backend exposes models through /codex/responses, not /models)");

  const model = catalog.find((entry) => entry.id === requestedModel);
  if (model === undefined) {
    console.error(`MODEL_NOT_IN_CATALOG: ${requestedModel}`);
    return 3;
  }

  const collection = createCollection();
  collection.setProvider(createSubscriptionPiProvider());
  const efforts = getSupportedThinkingLevels(model);
  console.log(`wire test model: ${model.id}, efforts: ${efforts.join(",")}`);

  let failures = 0;
  for (const effort of efforts) {
    const context = {
      messages: [
        {
          role: "user",
          content: "Reply with exactly OK",
        },
      ],
    };
    try {
      const message = await collection.completeSimple(model, context, {
        apiKey: access,
        reasoning: effort,
        maxTokens: 64,
        maxRetries: 0,
      });
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      const errorMessage = message.errorMessage ?? "";
      console.log(`${effort}: stop=${message.stopReason} text=${JSON.stringify(text)} error=${JSON.stringify(errorMessage)}`);
      if (errorMessage.length > 0 || message.stopReason === "error" || text !== "OK") failures += 1;
    } catch (error) {
      failures += 1;
      console.error(`${effort}: ERROR ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures > 0) {
    console.error(`SMOKE_FAILED: ${failures}/${efforts.length} API cases failed`);
    return 4;
  }
  return 0;
}

if (process.argv[1]?.endsWith("smoke-test.mjs") && process.env.NODE_TEST_CONTEXT === undefined) {
  process.exitCode = await main();
}

export { main };
