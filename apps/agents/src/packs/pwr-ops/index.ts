// Bundled pack — registers procedure_lookup using the wiki binding from
// pack.json. Compiled into the binary like synthetic-demos; the wiki
// content itself is always fetched fresh from GitHub at tool-call time.
//
// Future remote-pack extraction can move this directory to a Pack repository;
// the manifest remains the authoritative metadata either way.

import type { Tool } from '../../core/types/tool.ts'
import { createWikiSource } from '../../wikis/wiki-fetcher.ts'
import { buildProcedureLookupTool } from './tools/procedure-lookup.ts'
import { buildWikiLookupTool } from './tools/wiki-lookup.ts'
import { buildEalClassifyTool } from './tools/eal-classify.ts'
import { buildProcedureSearchTool } from './tools/procedure-search.ts'
import { PWR_OPS_MANIFEST } from './manifest.ts'

const wiki = PWR_OPS_MANIFEST.wikis[0]
if (!wiki || !wiki.source) {
  throw new Error('[packs/pwr-ops] pack.json must declare wikis[0].source — fix the manifest')
}
const source = createWikiSource(wiki.source)

export const PWR_OPS_TOOLS: ReadonlyArray<Tool> = [
  buildProcedureLookupTool({ source, wikiName: wiki.name, wikiHomepage: wiki.url }),
  buildWikiLookupTool({ source, wikiName: wiki.name, wikiHomepage: wiki.url }),
  buildEalClassifyTool({ source, wikiName: wiki.name }),
  buildProcedureSearchTool({ source, wikiName: wiki.name, wikiHomepage: wiki.url }),
]
