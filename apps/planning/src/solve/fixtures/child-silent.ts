// Test support (the adversary's stand-in, adversary/rig/child-boundary): a solver child that receives its
// job and never answers, as a hung compile, bounds or check would.
process.on('message', () => {})
process.on('disconnect', () => process.exit(0))
setInterval(() => {}, 1_000)
