/** Small literal matcher shared by discoverable World catalogs. It deliberately
 * adds no synonyms or domain meaning: every query term must occur in the
 * advertised text, while punctuation and case do not matter. */
export const literalSearchTerms = (value: string): ReadonlyArray<string> =>
  [...new Set(value.normalize('NFKD').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]

export const matchesLiteralSearch = (
  query: string | undefined,
  fields: ReadonlyArray<string | undefined>,
): boolean => {
  if (query === undefined || query.trim() === '') return true
  const haystack = fields.filter((field): field is string => field !== undefined)
    .join(' ')
    .normalize('NFKD')
    .toLocaleLowerCase()
  return literalSearchTerms(query).every(term => haystack.includes(term))
}
