// Test support: the real solver child (child.ts) whose start takes SLOW_START_MS of busy CPU before it takes
// its job, as a child's spawn and module load do under the service's CPU quota (seconds, not the Mac's 50 ms).
// child.ts is evaluated first and listens; the job the pool sends waits until this module has run.
import '../child.ts'

export const SLOW_START_MS = 1_500
const until = performance.now() + SLOW_START_MS
while (performance.now() < until) { /* a slow start is busy, not asleep */ }
