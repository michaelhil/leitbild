import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fineRoot = resolve(root, '..');

interface Package {
  id: string;
  name: string;
  source: string | null;
  manifest_path: string;
  targets: { src_path: string }[];
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../'));
}

// This explicit native CI check is not part of the application's Bun test
// discovery: publishing the existing app must not require a Rust toolchain.
// Working directory selects the kernel's pinned Rust toolchain. Inspect the
// actual build graph, not a list of forbidden physics words.
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--format-version', '1'], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})) as { workspace_root: string; workspace_members: string[]; packages: Package[] };
assert.equal(resolve(metadata.workspace_root), root);
const operating = metadata.packages.find((pkg) => resolve(pkg.manifest_path) === resolve(root, 'Cargo.toml'));
assert(operating, 'Operating package must exist in the actual Cargo graph');
assert.equal(operating.name, 'leitbild-operating-plant');
assert.deepEqual(metadata.workspace_members, [operating.id]);
for (const pkg of metadata.packages) {
  assert.notEqual(pkg.name, 'leitbild-plant-numerics');
  if (pkg.source === null && within(fineRoot, pkg.manifest_path)) {
    assert(within(root, pkg.manifest_path), 'Operating build must not inherit the fine research crate');
  }
}
for (const target of operating.targets) assert(within(root, target.src_path));
console.log('PASS: standalone operating build graph excludes the fine research kernel');
