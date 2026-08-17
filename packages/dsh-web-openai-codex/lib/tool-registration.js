import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  fetchMetaFromValue,
  formatFetchOutput,
  formatSearchOutput,
  parseFetchArgs,
  parseSearchArgs,
  presentFetchCall,
  presentFetchResult,
  presentSearchCall,
  presentSearchResult,
  searchMetaFromValue,
} from "@deepseek-ai/dsh-tool-web";

const SEARCH_GUIDANCE = "Use the web_search tool to discover current information on the web. It returns a Codex-generated answer plus structured source URLs. Follow up with web_fetch when you need the full content of a specific public result, and cite the relevant URLs as markdown links.";
const FETCH_GUIDANCE = "Use the web_fetch tool to retrieve a specific public HTTP(S) URL (for example a result from web_search). It blocks local and private-network destinations and returns text/HTML, extracted PDF text, or bounded gzip-contained text/PDF content. Cite the URL as a markdown link when you use its content.";

function sourceValue(source) {
  return {
    url: source.url,
    ...(source.title !== undefined ? { title: source.title } : {}),
    ...(source.snippet !== undefined ? { snippet: source.snippet } : {}),
    ...(source.publishedAt !== undefined ? { publishedAt: source.publishedAt } : {}),
  };
}

function searchTool(searchProvider, agent, options) {
  return defineTool({
    name: "web_search",
    description: "Search the web for current information. Returns a Codex-generated answer and structured source URLs.",
    parameters: {
      query: {
        type: "string",
        required: true,
        description: "The search query.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          content: { type: "string" },
          sources: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                url: { type: "string", required: true },
                title: { type: "string" },
                snippet: { type: "string" },
                publishedAt: { type: "string" },
              },
            },
          },
          truncated: { type: "boolean", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: formatSearchOutput(value) }],
      presentationMeta: (_args, value) => searchMetaFromValue(value),
    },
    timeoutMs: options.searchTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = parseSearchArgs(args);
      const result = await searchProvider.search({
        query: input.query,
        maxResults: options.searchMaxResults,
      }, exec.signal, agent, options);
      return {
        ...(result.content !== undefined ? { content: result.content } : {}),
        sources: result.sources.map(sourceValue),
        truncated: result.truncated,
      };
    },
    presentCall: presentSearchCall,
    presentResult: (args, result) => presentSearchResult(args, result),
  });
}

function fetchTool(fetchProvider, options) {
  return defineTool({
    name: "web_fetch",
    description: "Fetch a public HTTP(S) URL after safety checks; returns text/HTML, extracted PDF text, or bounded gzip-contained text/PDF content.",
    parameters: {
      url: {
        type: "string",
        required: true,
        description: "The public HTTP(S) URL to fetch.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true },
          statusCode: { type: "integer", required: true },
          body: {
            required: true,
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  kind: { type: "string", required: true, const: "html" },
                  content: { type: "string", required: true },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  kind: { type: "string", required: true, const: "text" },
                  content: { type: "string", required: true },
                },
              },
            ],
          },
          truncated: { type: "boolean", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: formatFetchOutput(value, options.fetchMaxOutputChars) }],
      presentationMeta: (_args, value) => fetchMetaFromValue(value, options.fetchMaxOutputChars),
    },
    timeoutMs: options.fetchTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = parseFetchArgs(args);
      const result = await fetchProvider.fetch({ url: input.url }, exec.signal);
      return {
        url: result.url,
        statusCode: result.statusCode,
        body: { kind: result.body.kind, content: result.body.content },
        truncated: result.truncated,
      };
    },
    presentCall: presentFetchCall,
    presentResult: (args, result) => presentFetchResult(args, result),
  });
}

function combinedDisposer(disposers) {
  let remaining = [...disposers].reverse();
  return () => {
    if (remaining.length === 0) return;
    const failed = [];
    const errors = [];
    for (const dispose of remaining) {
      try {
        dispose();
      } catch (error) {
        failed.push(dispose);
        errors.push(error);
      }
    }
    remaining = failed;
    if (errors.length > 0) throw new AggregateError(errors, "failed to remove Codex web tools");
  };
}

export function installAgentWebTools(agent, searchProvider, fetchProvider, options) {
  const disposers = [];
  try {
    disposers.push(agent.ctx.systemPrompt.section({
      name: "tool:web_search",
      order: 110,
      text: SEARCH_GUIDANCE,
    }));
    disposers.push(agent.ctx.tools.register(searchTool(searchProvider, agent, options)));
    disposers.push(agent.ctx.systemPrompt.section({
      name: "tool:web_fetch",
      order: 111,
      text: FETCH_GUIDANCE,
    }));
    disposers.push(agent.ctx.tools.register(fetchTool(fetchProvider, options)));
  } catch (error) {
    try {
      combinedDisposer(disposers)();
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "failed to install Codex web tools and roll back partial registrations");
    }
    throw error;
  }
  return combinedDisposer(disposers);
}

export { fetchTool, searchTool };
