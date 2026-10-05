// Backport the GPT-6.1 Sol descriptor from pi-ai 0.99.2's OpenAI Codex
// catalog while continuing to use the Harness's shared 0.87.1 transport.
// Keep the subscription catalog's 272K context limit; the API's larger
// advertised window is not evidence of a larger ChatGPT subscription limit.
// https://developers.openai.com/api/docs/models/gpt-6.1-sol
const GPT_61_SOL = {
  id: "gpt-6.1-sol",
  name: "GPT-6.1 Sol",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text", "image"],
  cost: {
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: 2.5,
    tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
  },
  contextWindow: 272000,
  maxTokens: 128000,
  thinkingLevelMap: {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  },
  compat: {
    supportsOpenAIGrammarTools: true,
    supportsAdditionalTools: true,
    supportsToolSearch: true,
    supportsMidConvoSystemMessages: true,
  },
  inputLimits: {
    images: {
      resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 },
    },
  },
};

export function supplementCodexCatalog(models) {
  const result = [...models];
  if (!result.some((model) => model.id === GPT_61_SOL.id)) {
    result.push(structuredClone(GPT_61_SOL));
  }
  return result;
}
