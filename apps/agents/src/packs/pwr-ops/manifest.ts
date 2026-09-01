import packManifest from './pack.json' with { type: 'json' }
import { parsePackManifest } from '../manifest.ts'

export const PWR_OPS_MANIFEST = parsePackManifest(packManifest, 'src/packs/pwr-ops/pack.json')
