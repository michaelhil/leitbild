export const aviationDomain = 'aviation'

// The B.1 noop provider is still the pack default; scenarios opt into
// `aviation.opensky` via providerOverrides. VATSIM lands in B.3.
export const aviationNoopProviderId = 'aviation.noop'
export const aviationNoopAdapterId = aviationNoopProviderId

export const aviationOpenSkyProviderId = 'aviation.opensky'
export const aviationOpenSkyAdapterId = aviationOpenSkyProviderId

export const aviationVatsimProviderId = 'aviation.vatsim'
export const aviationVatsimAdapterId = aviationVatsimProviderId
