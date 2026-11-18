// Checks procedure documents as publication will, and prints the table a person reads once.
// Usage: bun packages/procmd/src/check-document.ts <file>...
import { readFile } from 'node:fs/promises'
import { parseProcedure } from './parser.ts'
import { checkProcedureLimits, procedureLimitTable } from './publication.ts'

for (const path of process.argv.slice(2)) {
  console.log(`\n# ${path}`)
  try {
    const parsed = parseProcedure(await readFile(path, 'utf8'))
    const problems = checkProcedureLimits(parsed)
    for (const problem of problems) console.log(`PROBLEM ${problem}`)
    for (const diagnostic of parsed.diagnostics) console.log(`diagnostic ${diagnostic}`)
    if (problems.length > 0) process.exitCode = 1
    console.log(procedureLimitTable(parsed))
  } catch (error) {
    console.log(`PROBLEM ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
