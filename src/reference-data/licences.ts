import { asLicenceId, type LicenceId, type LicenceRef } from './types.ts'

// Known licence registry.
// Datasets reference licences from this registry; the manifest writer rejects unknown ids.

export const ccByNcSa40: LicenceRef = {
  id: asLicenceId('cc-by-nc-sa-4.0'),
  name: 'Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International',
  url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
  attribution: '© OpenAIP contributors · CC BY-NC-SA 4.0',
  commercialUseAllowed: false,
  redistributionAllowed: true,
  shareAlike: true,
}

export const nlod20: LicenceRef = {
  id: asLicenceId('nlod-2.0'),
  name: 'Norwegian Licence for Open Government Data 2.0',
  url: 'https://data.norge.no/nlod/en/2.0',
  attribution: '© Avinor / Kartverket · NLOD 2.0',
  commercialUseAllowed: true,
  redistributionAllowed: true,
  shareAlike: false,
}

export const osmOdbl: LicenceRef = {
  id: asLicenceId('osm-odbl-1.0'),
  name: 'Open Data Commons Open Database License 1.0',
  url: 'https://opendatacommons.org/licenses/odbl/1-0/',
  attribution: '© OpenStreetMap contributors · ODbL 1.0',
  commercialUseAllowed: true,
  redistributionAllowed: true,
  shareAlike: true,
}

export const repoOwned: LicenceRef = {
  id: asLicenceId('repo-owned'),
  name: 'Repository-owned content',
  url: '',
  attribution: '© Leitbild contributors',
  commercialUseAllowed: true,
  redistributionAllowed: true,
  shareAlike: false,
}

const knownLicences: ReadonlyArray<LicenceRef> = [ccByNcSa40, nlod20, osmOdbl, repoOwned]

export const findLicence = (id: LicenceId): LicenceRef | null =>
  knownLicences.find(licence => licence.id === id) ?? null

export const assertKnownLicence = (licence: LicenceRef): void => {
  if (findLicence(licence.id) === null) {
    throw new Error(`unknown licence id: ${licence.id}. Register it in src/reference-data/licences.ts before referencing it from a dataset.`)
  }
}
