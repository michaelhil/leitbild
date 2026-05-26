#!/usr/bin/env bun
// Convenience: invoke build then promote for any dataset that built successfully.
// Used by the weekly systemd timer.
await import('./build.ts').catch(err => {
  console.error('reference:rebuild — build phase failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
await import('./promote.ts').catch(err => {
  console.error('reference:rebuild — promote phase failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
