import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  LocalAgentProviderCandidate,
  LocalAgentProviderImportRequest,
  LocalAgentProviderImportResult,
  LocalAgentProviderProbeRequest,
  LocalAgentProviderProbeResult,
  LocalAgentProviderScanRequest
} from "@ccr/core/contracts/app";
import { claudeCodeCandidate, claudeCodeDefaultConfigDir, importClaudeCodeProvider } from "@ccr/core/agents/local-providers/claude-code";
import { codexCandidate, codexDefaultConfigDir, importCodexProvider, probeCodexProvider } from "@ccr/core/agents/local-providers/codex";
import { grokCandidate, importGrokProvider } from "@ccr/core/agents/local-providers/grok";
import { importKimiProvider, kimiCandidates } from "@ccr/core/agents/local-providers/kimi";
import { importOpenCodeProvider, opencodeCandidates } from "@ccr/core/agents/local-providers/opencode";
import { importZcodeProvider, zcodeCandidate } from "@ccr/core/agents/local-providers/zcode";
import { normalizeLocalAgentConfigDir } from "@ccr/core/agents/local-providers/source";

export { codexDefaultBaseUrl, readCodexAuth } from "@ccr/core/agents/local-providers/codex";
export { readClaudeCodeOauth } from "@ccr/core/agents/local-providers/claude-code";
export { grokDefaultBaseUrl, readGrokAuth, resolveGrokAuth } from "@ccr/core/agents/local-providers/grok";
export { kimiAccessTokenExpired, kimiIdentityHeaders, readKimiAuth, resolveKimiAuth } from "@ccr/core/agents/local-providers/kimi";
export { readZcodeLocalProviderCredential, zcodeDefaultBaseUrl } from "@ccr/core/agents/local-providers/zcode";
export { localAgentProviderApiKey, type OAuthTokenSet } from "@ccr/core/agents/local-providers/shared";

export function getLocalAgentProviderCandidates(
  request?: LocalAgentProviderScanRequest
): LocalAgentProviderCandidate[] {
  if (request) {
    const configDir = resolveLocalAgentConfigDir(request.configDir);
    if (request.kind !== "claude-code" && request.kind !== "codex") {
      throw new Error("Local agent provider source kind is not supported.");
    }
    return [
      request.kind === "codex"
        ? codexCandidate(configDir)
        : claudeCodeCandidate(configDir)
    ];
  }

  return [
    {
      ...codexCandidate(),
      defaultConfigDir: codexDefaultConfigDir()
    },
    {
      ...claudeCodeCandidate(),
      defaultConfigDir: claudeCodeDefaultConfigDir()
    },
    grokCandidate(),
    ...kimiCandidates(),
    ...opencodeCandidates(),
    zcodeCandidate()
  ].filter(
    (candidate) =>
      candidate.status !== "missing" ||
      candidate.kind === "codex" ||
      candidate.kind === "claude-code"
  );
}

export async function importLocalAgentProvider(request: LocalAgentProviderImportRequest): Promise<LocalAgentProviderImportResult> {
  const configDir = request.configDir === undefined
    ? undefined
    : resolveLocalAgentConfigDir(request.configDir);
  const candidate = request.id === "codex-api"
    ? codexCandidate(configDir)
    : request.id === "claude-code-api"
      ? claudeCodeCandidate(configDir)
      : getLocalAgentProviderCandidates().find((item) => item.id === request.id);
  if (!candidate) {
    throw new Error("Local agent provider was not found.");
  }
  if (!candidate.importable) {
    throw new Error(candidate.detail || "Local agent login is not importable.");
  }

  if (candidate.kind === "codex") {
    return importCodexProvider(candidate, request.providerNames ?? [], configDir);
  }
  if (candidate.kind === "claude-code") {
    return importClaudeCodeProvider(candidate, request.providerNames ?? [], configDir);
  }
  if (candidate.kind === "grok") {
    return importGrokProvider(candidate, request.providerNames ?? []);
  }
  if (candidate.kind === "kimi") {
    return importKimiProvider(candidate, request.providerNames ?? []);
  }
  if (candidate.kind === "opencode") {
    return importOpenCodeProvider(candidate, request.providerNames ?? []);
  }
  return importZcodeProvider(candidate, request.providerNames ?? []);
}

export async function probeLocalAgentProvider(request: LocalAgentProviderProbeRequest): Promise<LocalAgentProviderProbeResult> {
  const configDir = request.configDir === undefined
    ? undefined
    : resolveLocalAgentConfigDir(request.configDir);
  const candidate = request.id === "codex-api"
    ? codexCandidate(configDir)
    : getLocalAgentProviderCandidates().find((item) => item.id === request.id);
  if (!candidate) {
    throw new Error("Local agent provider was not found.");
  }
  if (candidate.kind === "codex") {
    return probeCodexProvider(candidate, configDir);
  }
  throw new Error("Local agent provider model probing is not supported.");
}

function resolveLocalAgentConfigDir(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Configuration directory must be a non-empty string.");
  }
  const input = value.trim();
  const expanded = input === "~"
    ? os.homedir()
    : /^~[\\/]/.test(input)
      ? path.join(os.homedir(), input.slice(2))
      : input;
  if (!path.isAbsolute(expanded)) {
    throw new Error("Configuration directory must be an absolute path or start with ~/.");
  }

  const configDir = normalizeLocalAgentConfigDir(expanded);
  let stats;
  try {
    stats = statSync(configDir);
  } catch {
    throw new Error(`Configuration directory does not exist: ${configDir}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Configuration path is not a directory: ${configDir}`);
  }
  return configDir;
}
