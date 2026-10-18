import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"]+)\1/g;

/** Every module specifier a source file imports, re-exports or dynamically imports. */
export function importSpecifiers(source: string): string[] {
  return [...source.matchAll(IMPORT_SPECIFIER)].map((match) => match[2] ?? '');
}

/**
 * Specifiers that leave the allowed directories: bare package names, Node built-ins, absolute paths
 * and relative paths that resolve outside every allowed directory.
 */
export function forbiddenImports(file: string, source: string, allowedDirs: string[]): string[] {
  return importSpecifiers(source).filter((specifier) => {
    if (!specifier.startsWith('.')) return true;
    const target = resolve(dirname(file), specifier);
    return !allowedDirs.some((dir) => target === dir || target.startsWith(dir + sep));
  });
}

export function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

export function checkDirectories(root: string, dirs: string[]): string[] {
  const allowed = dirs.map((dir) => resolve(root, dir));
  return allowed.flatMap((dir) =>
    sourceFiles(dir).flatMap((file) =>
      forbiddenImports(file, readFileSync(file, 'utf8'), allowed).map(
        (specifier) => `${relative(root, file)} imports "${specifier}"`,
      ),
    ),
  );
}
