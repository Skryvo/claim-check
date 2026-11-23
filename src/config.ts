import { chatModel, type ChatModel } from "./model.js";
import { SEARCH_PROVIDERS, type SearchName, type SearchProvider } from "./search/index.js";

export class ConfigError extends Error {}

export interface Settings {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  modelOptions?: string;
  search?: string;
  searchKey?: string;
}

export const SETUP = `claim-check has no default model: you choose the endpoint and the model, and your text goes to them.
Set them with flags or environment variables:

  CLAIM_CHECK_BASE_URL   an endpoint that speaks the chat completions protocol
  CLAIM_CHECK_MODEL      the model id at that endpoint
  CLAIM_CHECK_API_KEY    the key, when the endpoint needs one

A hosted router:
  export CLAIM_CHECK_BASE_URL=https://openrouter.ai/api/v1
  export CLAIM_CHECK_MODEL=<a model id from https://openrouter.ai/models>
  export CLAIM_CHECK_API_KEY=<your key>

A model on your own machine (an Ollama server):
  export CLAIM_CHECK_BASE_URL=http://localhost:11434/v1
  export CLAIM_CHECK_MODEL=<a model you pulled>`;

function pick(flag: string | undefined, env: string | undefined): string | undefined {
  const value = flag ?? env;
  return value?.trim() ? value.trim() : undefined;
}

export function modelFrom(settings: Settings, env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): ChatModel {
  const baseUrl = pick(settings.baseUrl, env.CLAIM_CHECK_BASE_URL);
  const model = pick(settings.model, env.CLAIM_CHECK_MODEL);
  if (!baseUrl || !model) {
    const missing = [!baseUrl && "CLAIM_CHECK_BASE_URL (--base-url)", !model && "CLAIM_CHECK_MODEL (--model)"]
      .filter(Boolean)
      .join(" and ");
    throw new ConfigError(`No model is set: ${missing} missing.\n\n${SETUP}`);
  }
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    throw new ConfigError(`The model base URL is not an http(s) address: ${baseUrl}`);
  }
  const rawOptions = pick(settings.modelOptions, env.CLAIM_CHECK_MODEL_OPTIONS);
  let options: Record<string, unknown> = {};
  if (rawOptions) {
    try {
      options = JSON.parse(rawOptions);
    } catch {
      throw new ConfigError(`Model options must be a JSON object, for example '{"max_tokens": 2000}'. Got: ${rawOptions}`);
    }
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new ConfigError("Model options must be a JSON object.");
    }
  }
  return chatModel(
    { baseUrl, model, apiKey: pick(settings.apiKey, env.CLAIM_CHECK_API_KEY) ?? null, options },
    fetchImpl,
  );
}

export function searchFrom(settings: Settings, env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): SearchProvider | null {
  const name = (pick(settings.search, env.CLAIM_CHECK_SEARCH) ?? "cited").toLowerCase();
  if (name === "cited") return null;
  if (!(name in SEARCH_PROVIDERS)) {
    throw new ConfigError(`Unknown search "${name}". Choose cited, ${Object.keys(SEARCH_PROVIDERS).join(", ")}.`);
  }
  const provider = SEARCH_PROVIDERS[name as SearchName];
  const key = pick(settings.searchKey, env[provider.env]);
  if (!key) throw new ConfigError(`Search "${name}" needs a key: set ${provider.env} (or --search-key).`);
  return provider.create(key, fetchImpl);
}
