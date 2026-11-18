// Test support: a solver child that ends without answering, as one killed by the OS would.
process.on('message', () => process.exit(3))
