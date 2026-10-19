import {
  createHttpError,
  isRecord,
  nativeRoot,
  readPositiveInteger,
  type ReasoningCapability
} from './chatCompletions';

export type EndpointType = 'ollama' | 'llamacpp' | 'vllm' | 'openai';

export const ENDPOINT_TYPES: readonly EndpointType[] = ['ollama', 'llamacpp', 'vllm', 'openai'];

export const ENDPOINT_PRESETS: Record<EndpointType, { label: string; baseURL: string; description: string }> = {
  ollama: { label: 'Ollama', baseURL: 'http://127.0.0.1:11434/v1', description: 'Native model metadata: tools, vision, thinking, context' },
  llamacpp: { label: 'llama.cpp server', baseURL: 'http://127.0.0.1:8080/v1', description: 'llama-server with /props context and vision metadata' },
  vllm: { label: 'vLLM', baseURL: 'http://127.0.0.1:8000/v1', description: 'vLLM OpenAI-compatible server' },
  openai: { label: 'OpenAI-compatible', baseURL: 'https://', description: 'Any other /v1/chat/completions server or hosted API' }
};

export interface EndpointConfig {
  name: string;
  type: EndpointType;
  baseURL: string;
  /** Fallback context window when the server does not report the served context. */
  contextSize: number;
  /** Explicit capability overrides; undefined means use the server metadata. */
  toolCalling?: boolean;
  vision?: boolean;
  /** Optional allow-list of model IDs. */
  models: string[];
}

export interface DiscoveredModel {
  id: string;
  displayName: string;
  contextLength: number;
  vision: boolean;
  toolCalling: boolean;
  reasoning?: ReasoningCapability;
  family?: string;
  loaded?: boolean;
  detail: string;
}

export interface DiscoveryContext {
  headers: Record<string, string>;
  signal: AbortSignal;
  /** Ollama `/api/show` results keyed by model name and digest, kept between discoveries. */
  ollamaShowCache: Map<string, OllamaShow>;
}

export interface OllamaShow {
  capabilities?: string[];
  contextLength?: number;
  family?: string;
}

// Ollama maps these onto both graduated (gpt-oss) and boolean thinking models.
const OLLAMA_REASONING: ReasoningCapability = { options: ['on', 'off', 'low', 'medium', 'high'], default: 'on' };
const OLLAMA_SHOW_CONCURRENCY = 4;

export async function discoverModels(endpoint: EndpointConfig, context: DiscoveryContext): Promise<DiscoveredModel[]> {
  const models = endpoint.type === 'ollama'
    ? await discoverOllamaModels(endpoint, context)
    : endpoint.type === 'llamacpp'
      ? await discoverLlamaCppModels(endpoint, context)
      : await discoverOpenAIModels(endpoint, context);
  const allowed = new Set(endpoint.models);
  return models
    .filter((model) => allowed.size === 0 || allowed.has(model.id))
    .map((model) => ({
      ...model,
      toolCalling: endpoint.toolCalling ?? model.toolCalling,
      vision: endpoint.vision ?? model.vision
    }));
}

async function discoverOllamaModels(endpoint: EndpointConfig, context: DiscoveryContext): Promise<DiscoveredModel[]> {
  const root = nativeRoot(endpoint.baseURL);
  const tags = await getJson(`${root}/api/tags`, endpoint, context);
  if (!isRecord(tags) || !Array.isArray(tags.models)) {
    throw new Error(`${endpoint.name} returned an invalid Ollama model list.`);
  }
  const loadedContext = await readOllamaLoadedContext(root, endpoint, context);
  const entries = tags.models.flatMap((value) => {
    if (!isRecord(value)) return [];
    const name = typeof value.model === 'string' && value.model ? value.model : typeof value.name === 'string' ? value.name : '';
    if (!name) return [];
    const details = isRecord(value.details) ? value.details : {};
    return [{ name, digest: typeof value.digest === 'string' ? value.digest : '', details }];
  });

  const shows = await mapWithConcurrency(entries, OLLAMA_SHOW_CONCURRENCY, async (entry) => {
    const cacheKey = `${root}\n${entry.name}\n${entry.digest}`;
    const cached = context.ollamaShowCache.get(cacheKey);
    if (cached) return cached;
    try {
      const show = parseOllamaShow(await postJson(`${root}/api/show`, { model: entry.name }, endpoint, context));
      if (entry.digest) context.ollamaShowCache.set(cacheKey, show);
      return show;
    } catch (error) {
      if (context.signal.aborted) throw error;
      return {};
    }
  });

  return entries.flatMap((entry, index): DiscoveredModel[] => {
    const show = shows[index];
    const capabilities = show.capabilities;
    // Embedding-only models cannot chat.
    if (capabilities && !capabilities.includes('completion')) return [];
    const loaded = loadedContext.get(entry.name);
    // `/v1` requests use the server's context (OLLAMA_CONTEXT_LENGTH), not the model maximum.
    const contextLength = loaded
      ?? (show.contextLength ? Math.min(show.contextLength, endpoint.contextSize) : endpoint.contextSize);
    const detail = [
      typeof entry.details.parameter_size === 'string' ? entry.details.parameter_size : undefined,
      typeof entry.details.quantization_level === 'string' ? entry.details.quantization_level : undefined,
      loaded ? 'loaded' : 'available'
    ].filter(Boolean).join(' · ');
    return [{
      id: entry.name,
      displayName: entry.name,
      contextLength,
      toolCalling: capabilities?.includes('tools') ?? false,
      vision: capabilities?.includes('vision') ?? false,
      reasoning: capabilities?.includes('thinking') ? OLLAMA_REASONING : undefined,
      family: show.family ?? (typeof entry.details.family === 'string' ? entry.details.family : undefined),
      loaded: loaded !== undefined,
      detail
    }];
  });
}

async function readOllamaLoadedContext(root: string, endpoint: EndpointConfig, context: DiscoveryContext): Promise<Map<string, number>> {
  const loaded = new Map<string, number>();
  try {
    const payload = await getJson(`${root}/api/ps`, endpoint, context);
    for (const value of isRecord(payload) && Array.isArray(payload.models) ? payload.models : []) {
      if (!isRecord(value)) continue;
      const name = typeof value.model === 'string' ? value.model : typeof value.name === 'string' ? value.name : '';
      const contextLength = readPositiveInteger(value.context_length);
      if (name && contextLength) loaded.set(name, contextLength);
    }
  } catch (error) {
    if (context.signal.aborted) throw error;
  }
  return loaded;
}

function parseOllamaShow(payload: unknown): OllamaShow {
  if (!isRecord(payload)) return {};
  const capabilities = Array.isArray(payload.capabilities)
    ? payload.capabilities.filter((value): value is string => typeof value === 'string')
    : undefined;
  const info = isRecord(payload.model_info) ? payload.model_info : {};
  const architecture = typeof info['general.architecture'] === 'string' ? info['general.architecture'] : undefined;
  return {
    capabilities,
    contextLength: architecture ? readPositiveInteger(info[`${architecture}.context_length`]) : undefined,
    family: architecture
  };
}

async function discoverLlamaCppModels(endpoint: EndpointConfig, context: DiscoveryContext): Promise<DiscoveredModel[]> {
  const list = await getJson(`${endpoint.baseURL}/models`, endpoint, context);
  let props: Record<string, unknown> = {};
  try {
    const payload = await getJson(`${nativeRoot(endpoint.baseURL)}/props`, endpoint, context);
    if (isRecord(payload)) props = payload;
  } catch (error) {
    if (context.signal.aborted) throw error;
  }
  const settings = isRecord(props.default_generation_settings) ? props.default_generation_settings : {};
  // `/props` reports the served per-slot context; `n_ctx_train` is only the trained maximum.
  const servedContext = readPositiveInteger(settings.n_ctx) ?? readPositiveInteger(props.n_ctx);
  const modalities = isRecord(props.modalities) ? props.modalities : {};
  const templateCaps = isRecord(props.chat_template_caps) ? props.chat_template_caps : {};
  const toolCalling = templateCaps.supports_tool_calls === true || templateCaps.supports_tools === true;
  return readModelList(list, endpoint).map((entry) => {
    const meta = isRecord(entry.meta) ? entry.meta : {};
    const trained = readPositiveInteger(meta.n_ctx_train);
    return {
      id: entry.id,
      displayName: entry.id,
      contextLength: servedContext ?? (trained ? Math.min(trained, endpoint.contextSize) : endpoint.contextSize),
      toolCalling,
      vision: modalities.vision === true,
      detail: servedContext ? 'served context from /props' : 'context from settings'
    };
  });
}

async function discoverOpenAIModels(endpoint: EndpointConfig, context: DiscoveryContext): Promise<DiscoveredModel[]> {
  const list = await getJson(`${endpoint.baseURL}/models`, endpoint, context);
  return readModelList(list, endpoint).map((entry) => {
    // vLLM publishes max_model_len; hosted routers commonly publish context_length and supported_parameters.
    const contextLength = readPositiveInteger(entry.max_model_len)
      ?? readPositiveInteger(entry.context_length)
      ?? readPositiveInteger(entry.context_window)
      ?? endpoint.contextSize;
    const architecture = isRecord(entry.architecture) ? entry.architecture : {};
    const inputModalities = Array.isArray(architecture.input_modalities) ? architecture.input_modalities : [];
    const supportedParameters = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : [];
    return {
      id: entry.id,
      displayName: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : entry.id,
      contextLength,
      // Unknown servers may reject tools, so they are offered to Agent mode only when metadata or settings say so.
      toolCalling: supportedParameters.includes('tools'),
      vision: inputModalities.includes('image'),
      detail: typeof entry.owned_by === 'string' && entry.owned_by ? entry.owned_by : ''
    };
  });
}

function readModelList(payload: unknown, endpoint: EndpointConfig): Array<Record<string, unknown> & { id: string }> {
  // llama.cpp also returns an Ollama-style `models` array next to `data`.
  const entries = isRecord(payload) && Array.isArray(payload.data) ? payload.data : undefined;
  if (!entries) {
    throw new Error(`${endpoint.name} returned an invalid model catalog.`);
  }
  return entries.flatMap((entry) => (
    isRecord(entry) && typeof entry.id === 'string' && entry.id.trim() ? [entry as Record<string, unknown> & { id: string }] : []
  ));
}

async function getJson(url: string, endpoint: EndpointConfig, context: DiscoveryContext): Promise<unknown> {
  const response = await fetch(url, { headers: context.headers, signal: context.signal });
  if (!response.ok) {
    throw await createHttpError(response, `${endpoint.name} model discovery failed`, endpoint.name);
  }
  return response.json();
}

async function postJson(url: string, body: unknown, endpoint: EndpointConfig, context: DiscoveryContext): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...context.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: context.signal
  });
  if (!response.ok) {
    throw await createHttpError(response, `${endpoint.name} model details failed`, endpoint.name);
  }
  return response.json();
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
