import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getLocalAgentProviderCandidates,
  importLocalAgentProvider,
  probeLocalAgentProvider
} from "@ccr/core/agents/local-providers/service.ts";

test("Claude import binds the provider to the requested configuration directory", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ccr-local-provider-service-"));
  const defaultConfigDir = path.join(home, ".claude");
  const configDir = path.join(home, ".claude-two");
  writeClaudeCredentials(defaultConfigDir, "default-access-token");
  writeClaudeCredentials(configDir, "second-access-token");
  const previousHome = process.env.HOME;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  process.env.HOME = home;
  Object.defineProperty(process, "platform", { configurable: true, value: "linux" });

  try {
    const result = await importLocalAgentProvider({
      configDir: "~/.claude-two",
      id: "claude-code-api"
    });

    assert.deepEqual(result.provider.localAgent, {
      configDir,
      kind: "claude-code"
    });
    assert.deepEqual(result.providerPlugins[0].localAgent, {
      configDir,
      kind: "claude-code"
    });
    assert.equal(result.providerPlugins[0].auth.headers.authorization, "Bearer second-access-token");
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    Object.defineProperty(process, "platform", platformDescriptor);
    rmSync(home, { force: true, recursive: true });
  }
});

test("Codex import binds the provider to the requested CODEX_HOME", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccr-local-provider-service-"));
  const processHome = path.join(root, "process-home");
  const configDir = path.join(root, "codex-two");
  writeCodexAuth(path.join(processHome, ".codex"), "default-refresh-token");
  writeCodexAuth(configDir, "second-refresh-token");
  writeFileSync(path.join(configDir, "models_cache.json"), JSON.stringify({
    models: [{ display_name: "Second Codex Model", slug: "second-codex-model" }]
  }));
  const previousInternalHome = process.env.CCR_INTERNAL_HOME_DIR;
  process.env.CCR_INTERNAL_HOME_DIR = processHome;

  try {
    const result = await importLocalAgentProvider({
      configDir,
      id: "codex-api"
    });

    assert.deepEqual(result.provider.localAgent, {
      configDir,
      kind: "codex"
    });
    assert.ok(result.provider.models.includes("second-codex-model"));
    assert.deepEqual(result.providerPlugins[0].localAgent, {
      configDir,
      kind: "codex"
    });
    assert.equal(result.providerPlugins[0].codexOauth.refreshToken, "second-refresh-token");
  } finally {
    if (previousInternalHome === undefined) {
      delete process.env.CCR_INTERNAL_HOME_DIR;
    } else {
      process.env.CCR_INTERNAL_HOME_DIR = previousInternalHome;
    }
    rmSync(root, { force: true, recursive: true });
  }
});

test("local provider scan reads only the requested source", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccr-local-provider-service-"));
  const defaultConfigDir = path.join(root, ".codex");
  const configDir = path.join(root, "codex-two");
  writeCodexAuth(defaultConfigDir, "default-refresh-token");
  writeCodexAuth(configDir, "second-refresh-token");
  const previousInternalHome = process.env.CCR_INTERNAL_HOME_DIR;
  process.env.CCR_INTERNAL_HOME_DIR = root;

  try {
    const candidates = getLocalAgentProviderCandidates({
      configDir,
      kind: "codex"
    });

    assert.equal(candidates.length, 1);
    assert.deepEqual(candidates[0].localAgent, {
      configDir,
      kind: "codex"
    });
    assert.equal(candidates[0].sourceFile, path.join(configDir, "auth.json"));
  } finally {
    if (previousInternalHome === undefined) {
      delete process.env.CCR_INTERNAL_HOME_DIR;
    } else {
      process.env.CCR_INTERNAL_HOME_DIR = previousInternalHome;
    }
    rmSync(root, { force: true, recursive: true });
  }
});

test("local provider scan keeps missing configurable providers discoverable", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccr-local-provider-service-"));
  const previousInternalHome = process.env.CCR_INTERNAL_HOME_DIR;
  process.env.CCR_INTERNAL_HOME_DIR = root;

  try {
    const candidate = getLocalAgentProviderCandidates().find((item) => item.kind === "codex");
    assert.equal(candidate?.status, "missing");
  } finally {
    if (previousInternalHome === undefined) {
      delete process.env.CCR_INTERNAL_HOME_DIR;
    } else {
      process.env.CCR_INTERNAL_HOME_DIR = previousInternalHome;
    }
    rmSync(root, { force: true, recursive: true });
  }
});

test("default local provider scan exposes the physical default source identity", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccr-local-provider-service-"));
  const previousInternalHome = process.env.CCR_INTERNAL_HOME_DIR;
  process.env.CCR_INTERNAL_HOME_DIR = root;

  try {
    const candidate = getLocalAgentProviderCandidates().find((item) => item.kind === "codex");
    assert.equal(candidate?.defaultConfigDir, path.join(root, ".codex"));
    assert.equal(candidate?.localAgent, undefined);
  } finally {
    if (previousInternalHome === undefined) {
      delete process.env.CCR_INTERNAL_HOME_DIR;
    } else {
      process.env.CCR_INTERNAL_HOME_DIR = previousInternalHome;
    }
    rmSync(root, { force: true, recursive: true });
  }
});

test("local provider scan rejects a missing configuration directory", () => {
  assert.throws(
    () => getLocalAgentProviderCandidates({}),
    { message: "Configuration directory must be a non-empty string." }
  );
});

test("local provider scan rejects an unsupported source kind", () => {
  assert.throws(
    () => getLocalAgentProviderCandidates({ configDir: os.tmpdir(), kind: "grok" }),
    { message: "Local agent provider source kind is not supported." }
  );
});

test("Codex probe reads models from the requested CODEX_HOME", async () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), "ccr-local-provider-service-"));
  writeCodexAuth(configDir, "second-refresh-token");
  writeFileSync(path.join(configDir, "models_cache.json"), JSON.stringify({
    models: [{ slug: "second-codex-model" }]
  }));

  try {
    const result = await probeLocalAgentProvider({
      configDir,
      id: "codex-api"
    });

    assert.deepEqual(result.candidate.localAgent, {
      configDir,
      kind: "codex"
    });
    assert.ok(result.probe.models.includes("second-codex-model"));
  } finally {
    rmSync(configDir, { force: true, recursive: true });
  }
});

test("local provider import rejects malformed supplied configuration directories", async () => {
  for (const configDir of ["", null, 42]) {
    await assert.rejects(
      importLocalAgentProvider({ configDir, id: "codex-api" }),
      /Configuration directory must be a non-empty string\./
    );
  }
});

test("local provider probe rejects malformed supplied configuration directories", async () => {
  for (const configDir of ["", null, 42]) {
    await assert.rejects(
      probeLocalAgentProvider({ configDir, id: "codex-api" }),
      /Configuration directory must be a non-empty string\./
    );
  }
});

test("local provider import rejects a relative configuration directory", async () => {
  await assert.rejects(
    importLocalAgentProvider({ configDir: ".claude-two", id: "claude-code-api" }),
    /absolute path or start with ~\//
  );
});

test("local provider import identifies a missing configuration directory", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccr-local-provider-service-"));
  const missing = path.join(root, "missing");
  try {
    await assert.rejects(
      importLocalAgentProvider({ configDir: missing, id: "codex-api" }),
      new RegExp(`Configuration directory does not exist: ${escapeRegExp(missing)}`)
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("local provider import rejects a configuration path that is not a directory", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccr-local-provider-service-"));
  const configFile = path.join(root, "config.json");
  writeFileSync(configFile, "{}");
  try {
    await assert.rejects(
      importLocalAgentProvider({ configDir: configFile, id: "claude-code-api" }),
      new RegExp(`Configuration path is not a directory: ${escapeRegExp(configFile)}`)
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

function writeClaudeCredentials(configDir, accessToken) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken }
  }));
}

function writeCodexAuth(configDir, refreshToken) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, "auth.json"), JSON.stringify({
    tokens: { refresh_token: refreshToken }
  }));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
