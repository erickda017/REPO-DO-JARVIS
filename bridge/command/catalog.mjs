/**
 * Built-in provider catalogue. Every id missing from the owner's config is appended, switched off and with no model,
 * so new providers show up in the app (and in old installed configs) without anyone editing JSON. The owner's own
 * entries always win: an id that already exists is never touched. Models stay empty on purpose: they are picked from
 * the provider's own catalogue after a key is saved, never guessed here.
 */
export const CATALOG = [
  { id: 'claude-api', type: 'anthropic', label: 'Claude (Anthropic API)', apiKeyEnv: 'ANTHROPIC_API_KEY', priority: 20 },
  { id: 'gemini', type: 'gemini', label: 'Google Gemini', apiKeyEnv: 'GEMINI_API_KEY', priority: 30 },
  { id: 'openai', type: 'openai-compat', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', tokenParam: 'max_completion_tokens', priority: 40 },
  { id: 'deepseek', type: 'openai-compat', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY', priority: 45 },
  { id: 'openrouter', type: 'openai-compat', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', priority: 50 },
  { id: 'nvidia', type: 'openai-compat', label: 'NVIDIA NIM (build.nvidia.com)', baseUrl: 'https://integrate.api.nvidia.com/v1', apiKeyEnv: 'NVIDIA_API_KEY', timeoutMs: 20000, priority: 55 }, // the model list is long and slow
  { id: 'groq', type: 'openai-compat', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY', priority: 60 },
  { id: 'mistral', type: 'openai-compat', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', apiKeyEnv: 'MISTRAL_API_KEY', priority: 70 },
].map((p) => ({ models: [], capabilities: ['chat', 'coding'], enabled: false, ...p }))

export function withCatalog(providers = []) {
  const have = new Set(providers.map((p) => p.id))
  return [...providers, ...CATALOG.filter((p) => !have.has(p.id)).map((p) => ({ ...p }))]
}
