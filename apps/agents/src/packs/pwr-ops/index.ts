// Bundled pack — registers procedure_lookup using the wiki binding from
// pack.json. Compiled into the binary like synthetic-demos; the wiki
// content itself is always fetched fresh from GitHub at tool-call time.
//
// Future remote-pack extraction can move this directory to a Pack repository;
// the manifest remains the authoritative metadata either way.

import type { Tool } from '../../core/types/tool.ts'
import { createProcedureLookupTool } from './tools/procedure-lookup.ts'
import { createWikiLookupTool } from './tools/wiki-lookup.ts'
import { createEalClassifyTool } from './tools/eal-classify.ts'
import { createProcedureSearchTool } from './tools/procedure-search.ts'
import { PWR_OPS_MANIFEST } from './manifest.ts'

const wiki = PWR_OPS_MANIFEST.wikis[0]
if (!wiki || !wiki.source) {
  throw new Error('[packs/pwr-ops] pack.json must declare wikis[0].source — fix the manifest')
}

export const PWR_OPS_TOOLS: ReadonlyArray<Tool> = [
  createProcedureLookupTool(wiki.source, wiki.name, wiki.url),
  createWikiLookupTool(wiki.source, wiki.name, wiki.url),
  createEalClassifyTool(wiki.source, wiki.name),
  createProcedureSearchTool(wiki.source, wiki.name, wiki.url),
]
