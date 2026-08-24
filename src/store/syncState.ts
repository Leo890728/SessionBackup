import { ManifestSession } from "./sessionStore";

export function fileKey(tool: string, relativePath: string): string {
  return `${tool}:${relativePath.replace(/\\/g, "/")}`;
}

/** 每個「檔案」跨機器取最新的 manifest 記錄（同一 rollout 檔在每台機器的 relativePath 相同）。 */
export function newestRemoteFiles(
  manifests: Array<{ machineId: string; sessions: ManifestSession[] }>
): Array<{ machineId: string; session: ManifestSession }> {
  const newest = new Map<string, { machineId: string; session: ManifestSession }>();
  for (const manifest of manifests) {
    for (const session of manifest.sessions) {
      const k = fileKey(session.tool, session.relativePath);
      const current = newest.get(k);
      if (!current || session.mtimeMs > current.session.mtimeMs) {
        newest.set(k, { machineId: manifest.machineId, session });
      }
    }
  }
  return [...newest.values()].sort(
    (a, b) =>
      b.session.mtimeMs - a.session.mtimeMs ||
      fileKey(a.session.tool, a.session.relativePath).localeCompare(
        fileKey(b.session.tool, b.session.relativePath)
      )
  );
}
