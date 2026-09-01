export const PROVIDER_PROFILES = {
  anthropic:  { baseUrl: 'https://api.anthropic.com/v1',                           defaultMaxConcurrent: 3, kind: 'cloud' },
  openai:     { baseUrl: 'https://api.openai.com/v1',                              defaultMaxConcurrent: 3, kind: 'cloud' },
  kimi:       { baseUrl: 'https://api.moonshot.ai/v1',                             defaultMaxConcurrent: 3, kind: 'cloud' },
  gemini:     { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultMaxConcurrent: 3, kind: 'cloud' },
  cerebras:   { baseUrl: 'https://api.cerebras.ai/v1',                             defaultMaxConcurrent: 2, kind: 'cloud' },
  groq:       { baseUrl: 'https://api.groq.com/openai/v1',                         defaultMaxConcurrent: 3, kind: 'cloud' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1',                           defaultMaxConcurrent: 1, kind: 'cloud' },
  mistral:    { baseUrl: 'https://api.mistral.ai/v1',                              defaultMaxConcurrent: 2, kind: 'cloud' },
  sambanova:  { baseUrl: 'https://api.sambanova.ai/v1',                            defaultMaxConcurrent: 2, kind: 'cloud' },
  llamacpp:   { baseUrl: 'http://localhost:8080',                                   defaultMaxConcurrent: 1, kind: 'local' },
} as const

export type CloudProviderName = keyof typeof PROVIDER_PROFILES

export const isLocal = (name: string): boolean => {
  if (name === 'ollama') return true
  const profile = (PROVIDER_PROFILES as Record<string, { kind: string } | undefined>)[name]
  return profile?.kind === 'local'
}
