import { createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai";

import { createSubscriptionPiProvider, gptModelCatalog, resolveOAuthAccessToken } from "./index.js";

async function main() {
  const args = process.argv.slice(2);
  const noCall = args.includes("--no-call");
  const modelFlag = args.find((arg) => arg.startsWith("--model="));
  const requestedModel = modelFlag?.slice("--model=".length) || "gpt-5.4-mini";

  const catalog = gptModelCatalog();
  console.log(`catalog gpt models: ${catalog.length}`);
  for (const model of catalog) {
    console.log(`- ${model.id}: efforts=${getSupportedThinkingLevels(model).join(",")}`);
  }

  const access = await resolveOAuthAccessToken(console);
  if (access === undefined) {
    console.error("NO_OAUTH_TOKEN: run dsh-openai-login first");
    return 2;
  }
  console.log("oauth access token: resolved");

  console.log("endpoint model listing: skipped (ChatGPT subscription backend exposes models through /codex/responses, not /models)");

  if (noCall) {
    console.log("SKIP_CALL");
    return 0;
  }

  const model = catalog.find((entry) => entry.id === requestedModel);
  if (model === undefined) {
    console.error(`MODEL_NOT_IN_CATALOG: ${requestedModel}`);
    return 3;
  }

  const collection = createModels();
  collection.setProvider(createSubscriptionPiProvider());
  const efforts = getSupportedThinkingLevels(model);
  console.log(`wire test model: ${model.id}, efforts: ${efforts.join(",")}`);

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
      console.log(`${effort}: stop=${message.stopReason} text=${JSON.stringify(text)} error=${JSON.stringify(message.errorMessage ?? "")}`);
    } catch (error) {
      console.log(`${effort}: ERROR ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return 0;
}

process.exitCode = await main();
