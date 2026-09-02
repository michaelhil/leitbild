// Shared manifest-backed wiki reader for Agent Packs. The manifest is the
// only discovery contract; document paths are never guessed from ids.

import {
  wikiManifestSchema,
  type WikiManifest,
  type WikiManifestPageEntry,
  type ProcedureManifestEntry,
} from '@leitbild/contracts'
import type { WikiSourceBinding } from '../packs/types.ts'
import { fetchWithTimeout } from '../core/fetch-utils.ts'

export type { WikiManifest, WikiManifestPageEntry, ProcedureManifestEntry }

const FETCH_TIMEOUT_MS = 8_000
const DEFAULT_TTL_MS = 5 * 60 * 1000
const USER_AGENT = 'leitbild-wiki/1.0'

interface BufferEntry {
  readonly value: string
  readonly fetchedAt: number
}

export interface WikiSource {
  readonly binding: WikiSourceBinding
  /** Fetch and validate the required discovery manifest. Throws when invalid or unavailable. */
  readonly fetchManifest: () => Promise<WikiManifest>
  /** Fetch a manifest-declared document, optionally pinned to an immutable Git revision. */
  readonly fetchDocument: (path: string, revision?: string) => Promise<string>
  /** Build the rendered wiki URL for a procedure id. */
  readonly citationUrl: (id: string) => string
}

export const createWikiSource = (
  binding: WikiSourceBinding,
  ttlMs: number = DEFAULT_TTL_MS,
): WikiSource => {
  const buffer = new Map<string, BufferEntry>()
  const pending = new Map<string, Promise<string>>()

  const rawUrl = (path: string, revision = binding.branch): string =>
    `https://raw.githubusercontent.com/${binding.org}/${binding.repo}/${revision}/${path}`

  // GitHub Pages mirrors current published artifacts. It is a safe fallback
  // only for unpinned reads; a revision-pinned read must never silently return
  // a different version.
  const pagesFallbackUrl = (path: string): string | null => {
    try {
      const base = new URL(binding.citationBase)
      const siteRoot = `${base.origin}${base.pathname.replace(/procedures\/?$/, '')}`
      const basename = path.split('/').pop()!
      if (basename === '_eal-rules.json') return `${siteRoot}_eal-rules.json`
      if (basename === '_search-index.json') return `${siteRoot}_search-index.json`
      return null
    } catch {
      return null
    }
  }

  const fetchFresh = async (path: string, revision?: string): Promise<string> => {
    const fetchUrl = rawUrl(path, revision)
    let response: Response
    try {
      response = await fetchWithTimeout(fetchUrl, { headers: { 'User-Agent': USER_AGENT } }, FETCH_TIMEOUT_MS)
    } catch (error) {
      if (revision) throw error
      const fallback = pagesFallbackUrl(path)
      if (fallback) {
        try {
          const fallbackResponse = await fetchWithTimeout(fallback, { headers: { 'User-Agent': USER_AGENT } }, FETCH_TIMEOUT_MS)
          if (fallbackResponse.ok) return await fallbackResponse.text()
        } catch { /* report the original failure */ }
      }
      throw error
    }
    if (response.ok) return await response.text()
    if (!revision) {
      const fallback = pagesFallbackUrl(path)
      if (fallback) {
        try {
          const fallbackResponse = await fetchWithTimeout(fallback, { headers: { 'User-Agent': USER_AGENT } }, FETCH_TIMEOUT_MS)
          if (fallbackResponse.ok) return await fallbackResponse.text()
        } catch { /* report the original response */ }
      }
    }
    throw new Error(`HTTP ${response.status} fetching ${path} from ${binding.org}/${binding.repo}`)
  }

  const getBuffered = async (path: string, revision?: string): Promise<string> => {
    const key = `${revision ?? 'current'}:${path}`
    const cached = buffer.get(key)
    if (cached && Date.now() - cached.fetchedAt < ttlMs) return cached.value
    const active = pending.get(key)
    if (active) return active
    const request = fetchFresh(path, revision).then(value => {
      buffer.set(key, { value, fetchedAt: Date.now() })
      pending.delete(key)
      return value
    }, error => {
      pending.delete(key)
      throw error
    })
    pending.set(key, request)
    return request
  }

  const getManifest = async (): Promise<string> => {
    const key = 'manifest'
    const cached = buffer.get(key)
    if (cached && Date.now() - cached.fetchedAt < ttlMs) return cached.value
    const active = pending.get(key)
    if (active) return active
    const request = fetchWithTimeout(
      binding.manifestUrl,
      { headers: { 'User-Agent': USER_AGENT } },
      FETCH_TIMEOUT_MS,
    ).then(async response => {
      if (!response.ok) throw new Error(`HTTP ${response.status} fetching manifest from ${binding.manifestUrl}`)
      const value = await response.text()
      buffer.set(key, { value, fetchedAt: Date.now() })
      pending.delete(key)
      return value
    }, error => {
      pending.delete(key)
      throw error
    })
    pending.set(key, request)
    return request
  }

  return {
    binding,
    fetchManifest: async () => {
      const raw = await getManifest()
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        throw new Error(`${binding.org}/${binding.repo} published an invalid JSON manifest`, { cause: error })
      }
      const result = wikiManifestSchema.safeParse(parsed)
      if (!result.success) {
        throw new Error(`${binding.org}/${binding.repo} published an invalid procedure manifest: ${result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
      }
      return result.data
    },
    fetchDocument: (path, revision) => getBuffered(path, revision),
    citationUrl: id => `${binding.citationBase.replace(/\/$/, '')}/${id}/`,
  }
}
