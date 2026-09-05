// Diagnostic lookup only. Native tool shapes are independent of provider fallback.
export const inferProviderFromModelRef = (
  modelRef: string,
  catalog: Record<string, ReadonlyArray<{ readonly id: string }>>,
): string | undefined => {
  const colon = modelRef.indexOf(':')
  if (colon > 0) return modelRef.slice(0, colon)
  for (const [provider, list] of Object.entries(catalog)) {
    if (list.some(m => m.id === modelRef)) return provider
  }
  return undefined
}
