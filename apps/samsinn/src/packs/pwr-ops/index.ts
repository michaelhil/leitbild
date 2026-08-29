// Bundled pack — registers procedure_lookup using the wiki binding from
// pack.json. Compiled into the binary like synthetic-demos; the wiki
// content itself is always fetched fresh from GitHub at tool-call time.
//
// Future remote-pack extraction: move this directory to its own GitHub
// repo (samsinn-packs/pwr-ops), drop the bundled registration in
// bootstrap.ts, and the rest stays the same.

import type { Tool } from '../../core/types/tool.ts'
import packManifest from './pack.json' with { type: 'json' }
import { createProcedureLookupTool } from './tools/procedure-lookup.ts'
import { createWikiLookupTool } from './tools/wiki-lookup.ts'
import { createEalClassifyTool } from './tools/eal-classify.ts'
import { createProcedureSearchTool } from './tools/procedure-search.ts'
import { parsePackManifest } from '../manifest.ts'

const manifest = parsePackManifest(packManifest, 'src/packs/pwr-ops/pack.json')

const wiki = manifest.wikis[0]
if (!wiki || !wiki.source) {
  throw new Error('[packs/pwr-ops] pack.json must declare wikis[0].source — fix the manifest')
}

export const PWR_OPS_TOOLS: ReadonlyArray<Tool> = [
  createProcedureLookupTool(wiki.source, wiki.name, wiki.url),
  createWikiLookupTool(wiki.source, wiki.name, wiki.url),
  createEalClassifyTool(wiki.source, wiki.name),
  createProcedureSearchTool(wiki.source, wiki.name, wiki.url),
]

export const PWR_OPS_MANIFEST = manifest
