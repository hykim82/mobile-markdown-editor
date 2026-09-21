import { posix as posixPath } from "node:path";

// Maps WSL (`/mnt/c/...`) and Git-Bash (`/c/...`) drive-relative forms to
// Windows drive-letter form (`C:/...`) so a path can be compared against a
// root reported in either scheme. Without this, the *same* file seen through
// a different shell's path convention could be misjudged as a different path
// and slip past a guard entirely.
export function toDriveStyle(p) {
  let m = p.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (m) return `${m[1].toUpperCase()}:/${m[2]}`;
  m = p.match(/^\/([a-zA-Z])\/(.*)$/);
  if (m) return `${m[1].toUpperCase()}:/${m[2]}`;
  return p;
}

// Normalizes an arbitrary path string (backslashes, WSL/Git-Bash drive
// forms) onto a single posix-style absolute representation, resolving
// `.`/`..` segments. A relative input is resolved against `base` when
// provided (assumed already absolute/repo-relative), otherwise returned
// normalized as-is.
export function normalizeAbsolute(filePath, base) {
  const fp = toDriveStyle(filePath.replace(/\\/g, "/"));
  const isAbsolute = /^[a-zA-Z]:\//.test(fp) || fp.startsWith("/");

  if (isAbsolute) {
    return posixPath.normalize(fp);
  }
  if (base) {
    const baseNorm = toDriveStyle(base.replace(/\\/g, "/").replace(/\/$/, ""));
    return posixPath.normalize(`${baseNorm}/${fp}`);
  }
  return posixPath.normalize(fp);
}

// Resolves `filePath` against `root` and expresses the result relative to
// `root`, on the same normalized scheme. Anything that resolves outside
// `root` is reported as `insideRepo: false`.
export function normalizeToRepoRelative(filePath, root) {
  const resolved = normalizeAbsolute(filePath, root);
  const rootNorm = toDriveStyle(root.replace(/\\/g, "/").replace(/\/$/, ""));

  const resolvedLower = resolved.toLowerCase();
  const rootLower = rootNorm.toLowerCase();
  if (resolvedLower === rootLower) {
    return { relative: "", insideRepo: true };
  }
  if (resolvedLower.startsWith(`${rootLower}/`)) {
    return { relative: resolved.slice(rootNorm.length + 1), insideRepo: true };
  }
  return { relative: null, insideRepo: false };
}
