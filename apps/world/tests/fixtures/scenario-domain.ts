/**
 * A domain test that replaces a bundled Scenario's items, identities or cues
 * does not inherit that Scenario's audience-specific tutorial. Keep the
 * omission at the fixture transformation, never at compiler admission.
 */
export const withoutScenarioGuide = <T extends { readonly guide?: unknown }>(source: T): Omit<T, 'guide'> => {
  const { guide: _guide, ...domain } = source
  return domain
}
