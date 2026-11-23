import type { Usage } from "./types.js";
import { USER_AGENT } from "./version.js";

export interface ModelConfig {
  baseUrl: string;
  model: string;
  apiKey: string | null;
  options: Record<string, unknown>;
}

export interface ChatModel {
  readonly name: string;
  readonly usage: Usage;
  complete(system: string, user: string): Promise<string>;
}

export class ModelError extends Error {}

const TIMEOUT_MS = 120_000;
const RETRIES = 2;
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function chatModel(config: ModelConfig, fetchImpl: typeof fetch = fetch): ChatModel {
  const usage: Usage = { calls: 0, promptTokens: 0, completionTokens: 0, cost: null };
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  async function post(body: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": USER_AGENT,
            ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        if (attempt < RETRIES) {
          await wait(2000 * (attempt + 1));
          continue;
        }
        throw new ModelError(`Could not reach the model at ${endpoint}: ${(error as Error).message}`);
      }
      if (response.ok || !RETRYABLE.has(response.status) || attempt >= RETRIES) return response;
      const after = Number(response.headers.get("retry-after"));
      await response.body?.cancel();
      await wait(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 2000 * (attempt + 1));
    }
  }

  return {
    name: config.model,
    usage,
    async complete(system, user) {
      const response = await post(
        JSON.stringify({
          model: config.model,
          temperature: 0,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          ...config.options,
        }),
      );
      const raw = await response.text();
      if (!response.ok) {
        throw new ModelError(`The model endpoint answered ${response.status}: ${raw.slice(0, 300).trim()}`);
      }
      let data: {
        choices?: { message?: { content?: unknown } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      };
      try {
        data = JSON.parse(raw);
      } catch {
        throw new ModelError(`The model endpoint did not answer with JSON: ${raw.slice(0, 200).trim()}`);
      }
      usage.calls++;
      usage.promptTokens += data.usage?.prompt_tokens ?? 0;
      usage.completionTokens += data.usage?.completion_tokens ?? 0;
      if (typeof data.usage?.cost === "number") usage.cost = (usage.cost ?? 0) + data.usage.cost;
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new ModelError("The model answered with no text. Check the model id and its options.");
      }
      return content;
    },
  };
}

export function readJson(reply: string): Record<string, unknown> {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end < start) throw new ModelError(`The model's reply held no JSON: ${reply.slice(0, 200)}`);
  let value: unknown = null;
  try {
    value = JSON.parse(reply.slice(start, end + 1));
  } catch {
    value = null;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new ModelError(`The model's reply was not valid JSON: ${reply.slice(0, 200)}`);
}

export function snapshot(usage: Usage): Usage {
  return { ...usage };
}

export function since(before: Usage, after: Usage): Usage {
  return {
    calls: after.calls - before.calls,
    promptTokens: after.promptTokens - before.promptTokens,
    completionTokens: after.completionTokens - before.completionTokens,
    cost: after.cost === null ? null : after.cost - (before.cost ?? 0),
  };
}
