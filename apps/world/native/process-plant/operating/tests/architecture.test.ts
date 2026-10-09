import { describe, expect, test } from 'bun:test';
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

describe('approved operating-kernel build boundary', () => {
  test('actual Cargo graph is independent of the retained fine research build', () => {
    // Run in the kernel directory so rustup uses its pinned toolchain. This
    // checks the actual build graph, not a list of forbidden physics words.
    const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--format-version', '1'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })) as { workspace_root: string; workspace_members: string[]; packages: Package[] };
    expect(resolve(metadata.workspace_root)).toBe(root);
    const operating = metadata.packages.find((pkg) => resolve(pkg.manifest_path) === resolve(root, 'Cargo.toml'));
    expect(operating?.name).toBe('leitbild-operating-plant');
    expect(metadata.workspace_members).toEqual([operating!.id]);
    for (const pkg of metadata.packages) {
      expect(pkg.name).not.toBe('leitbild-plant-numerics');
      if (pkg.source === null && within(fineRoot, pkg.manifest_path)) {
        expect(within(root, pkg.manifest_path)).toBe(true);
      }
    }
    for (const target of operating!.targets) {
      expect(within(root, target.src_path)).toBe(true);
    }
  });
});
