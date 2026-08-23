import path from "node:path";

export function normalizeLocalAgentConfigDir(configDir: string): string {
  return path.normalize(configDir).normalize("NFC");
}

export function sameLocalAgentConfigDir(
  left: string | undefined,
  right: string | undefined
): boolean {
  return Boolean(
    left &&
    right &&
    normalizeLocalAgentConfigDir(left) === normalizeLocalAgentConfigDir(right)
  );
}
