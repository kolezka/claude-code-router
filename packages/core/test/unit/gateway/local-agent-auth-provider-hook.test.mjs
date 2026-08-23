import assert from "node:assert/strict";
import fs, { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultAppConfig } from "@ccr/core/config/default-config.ts";
import { compileCoreGatewayConfig } from "@ccr/core/gateway/core-runtime/config-compiler.ts";
import {
  createGatewayPlugin,
  isLocalAgentOauthProviderPlugin
} from "@ccr/core/gateway/core-runtime/local-agent-auth-provider-hook.ts";
import { virtualApplyPatchToolName } from "@ccr/core/gateway/internal/shared.ts";

test("Grok local agent auth hook refreshes live login state before authenticating upstream requests", async (t) => {
  await withGrokHome(t, async (grokHome) => {
    writeGrokAuth(grokHome, {
      expires_at: "2000-01-01T00:00:00Z",
      key: "expired-grok-access-token",
      oidc_client_id: "grok-client-id",
      oidc_issuer: "https://auth.x.ai",
      refresh_token: "grok-refresh-token"
    });

    const previousFetch = globalThis.fetch;
    const previousTokenEndpoint = process.env.GROK_OIDC_TOKEN_ENDPOINT;
    process.env.GROK_OIDC_TOKEN_ENDPOINT = "http://127.0.0.1/grok/oauth/token";
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "http://127.0.0.1/grok/oauth/token");
      assert.equal(String(init?.body ?? ""), "client_id=grok-client-id&grant_type=refresh_token&refresh_token=grok-refresh-token");
      return new Response(JSON.stringify({
        access_token: "refreshed-grok-access-token",
        expires_in: 3600,
        refresh_token: "refreshed-grok-refresh-token"
      }), { headers: { "content-type": "application/json" }, status: 200 });
    };
    t.after(() => {
      globalThis.fetch = previousFetch;
      restoreEnv("GROK_OIDC_TOKEN_ENDPOINT", previousTokenEndpoint);
    });

    const [hook] = createGatewayPlugin({
      config: {
        providerPlugins: [grokOauthProviderPlugin()]
      }
    }).providerHooks;
    assert.equal(hook.key, "config:ccr-local-agent-grok-cli-api-grok-cli-oauth");

    const patch = "*** Begin Patch\n*** Add File: grok.txt\n+hi\n*** End Patch\n";
    const upstreamRequest = {
      body: {
        external_web_access: true,
        input: [
          { type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: patch },
          { type: "custom_tool_call_output", call_id: "call_patch", output: "Success" }
        ],
        model: "wrong-model",
        parallel_tool_calls: true,
        tool_choice: "auto",
        tools: [
          { type: "function", name: "exec_command" },
          { type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition: "start: begin_patch" } },
          { type: "namespace", name: "multi_agent_v1" },
          { type: "web_search" }
        ]
      },
      headers: {
        "content-type": "application/json",
        "x-api-key": "client-key"
      },
      method: "POST",
      url: "https://cli-chat-proxy.grok.com/v1/responses"
    };
    const authResult = await hook.authenticate({
      model: "grok-4.5",
      upstreamRequest
    });

    assert.equal(authResult.ok, true);
    assert.equal(authResult.value.headers.authorization, "Bearer refreshed-grok-access-token");
    assert.equal(authResult.value.headers["x-api-key"], undefined);
    assert.equal(upstreamRequest.headers["x-api-key"], "client-key");

    const requestResult = await hook.transformRequest({
      model: "grok-4.5",
      upstreamRequest: authResult.value
    });
    assert.equal(requestResult.ok, true);
    assert.equal(requestResult.value.headers["x-grok-client-identifier"], "xai-grok-cli");
    assert.equal(requestResult.value.headers["x-grok-client-version"], "0.2.93");
    assert.equal(requestResult.value.headers["x-grok-model-override"], "grok-4.5");
    assert.equal(requestResult.value.body.external_web_access, undefined);
    assert.deepEqual(requestResult.value.body.tools.map((tool) => tool.type), ["function", "function"]);
    assert.equal(requestResult.value.body.tools[1].name, virtualApplyPatchToolName);
    assert.equal(requestResult.value.body.tools.some((tool) => tool.type === "custom" || tool.type === "namespace"), false);
    assert.equal(requestResult.value.body.tool_choice, "auto");
    assert.equal(requestResult.value.body.parallel_tool_calls, true);
    assert.match(requestResult.value.body.instructions, /When modifying files, call virtual_apply_patch/);
    assert.equal(requestResult.value.body.input[0].type, "function_call");
    assert.equal(requestResult.value.body.input[0].name, virtualApplyPatchToolName);
    assert.deepEqual(JSON.parse(requestResult.value.body.input[0].arguments), { patch });
    assert.equal(requestResult.value.body.input[1].type, "function_call_output");

    const persisted = JSON.parse(readFileSync(path.join(grokHome, "auth.json"), "utf8"));
    assert.equal(persisted["https://auth.x.ai::test-account"].key, "refreshed-grok-access-token");
  });
});

// Regression for musistudio/claude-code-router#1628: the imported plugin's
// auth.headers carry a token snapshot from import time, but the hook must
// resolve the current on-disk token on every call so a rotation picked up by
// the interactive Claude Code CLI is honored without a gateway restart.
test("Claude Code local agent auth hook re-reads the on-disk access token on every request", { skip: process.platform === "win32" }, async () => {
  await withClaudeCodeHome(async (home) => {
    await withPlatform("darwin", async () => {
      await withFakeSecurityFailure(async () => {
        writeClaudeCredentials(home, {
          accessToken: "stale-imported-access-token",
          refreshToken: "stale-refresh-token"
        });

        const [hook] = createGatewayPlugin({
          config: {
            providerPlugins: [claudeCodeOauthProviderPlugin()]
          }
        }).providerHooks;
        assert.equal(hook.key, "config:ccr-local-agent-claude-code-api-claude-code-oauth");

        const upstreamRequest = {
          headers: {
            "content-type": "application/json",
            "x-api-key": "client-key"
          },
          method: "POST",
          url: "https://api.anthropic.com/v1/messages"
        };

        const staleAuth = await hook.authenticate({ upstreamRequest });
        assert.equal(staleAuth.ok, true);
        assert.equal(staleAuth.value.headers.authorization, "Bearer stale-imported-access-token");
        assert.equal(staleAuth.value.headers["x-api-key"], undefined);
        assert.equal(upstreamRequest.headers["x-api-key"], "client-key");

        // Simulate the interactive Claude Code CLI rotating the shared token
        // family on disk -- no gateway restart, no re-import.
        writeClaudeCredentials(home, {
          accessToken: "rotated-access-token",
          refreshToken: "rotated-refresh-token"
        });

        const rotatedAuth = await hook.authenticate({ upstreamRequest });
        assert.equal(rotatedAuth.ok, true);
        assert.equal(rotatedAuth.value.headers.authorization, "Bearer rotated-access-token");
        assert.equal(rotatedAuth.value.headers["anthropic-beta"], "oauth-2025-04-20");
      });
    });
  });
});

test("Claude Code request auth hook reads the provider configuration directory", async () => {
  await withClaudeCodeHome(async (home) => {
    await withPlatform("linux", async () => {
      writeClaudeCredentials(home, { accessToken: "default-access-token" });
      const configDir = path.join(home, ".claude-two");
      writeClaudeCredentialsAt(configDir, { accessToken: "second-access-token" });
      const plugin = claudeCodeOauthProviderPlugin();
      plugin.localAgent = { configDir, kind: "claude-code" };
      const [hook] = createGatewayPlugin({
        config: { providerPlugins: [plugin] }
      }).providerHooks;

      const result = await hook.authenticate({
        upstreamRequest: {
          headers: {},
          method: "POST",
          url: "https://api.anthropic.com/v1/messages"
        }
      });

      assert.equal(result.ok, true);
      assert.equal(result.value.headers.authorization, "Bearer second-access-token");
    });
  });
});

test("core gateway compiler isolates Claude Code runtime credentials by provider configuration directory", async () => {
  await withClaudeCodeHome(async (home) => {
    await withPlatform("linux", async () => {
      const firstConfigDir = path.join(home, ".claude-one");
      const secondConfigDir = path.join(home, ".claude-two");
      writeClaudeCredentialsAt(firstConfigDir, { accessToken: "first-live-access-token" });
      writeClaudeCredentialsAt(secondConfigDir, { accessToken: "second-live-access-token" });

      const firstPlugin = claudeCodeOauthProviderPlugin();
      firstPlugin.key = "ccr-local-agent-claude-one-claude-code-oauth";
      firstPlugin.providerName = "Claude One";
      firstPlugin.auth.headers.authorization = "Bearer first-stale-access-token";
      firstPlugin.localAgent = { configDir: secondConfigDir, kind: "claude-code" };
      const secondPlugin = claudeCodeOauthProviderPlugin();
      secondPlugin.key = "ccr-local-agent-claude-two-claude-code-oauth";
      secondPlugin.providerName = "Claude Two";
      secondPlugin.auth.headers.authorization = "Bearer second-stale-access-token";
      secondPlugin.localAgent = { configDir: firstConfigDir, kind: "claude-code" };

      const config = createDefaultAppConfig();
      config.providerPlugins = [firstPlugin, secondPlugin];
      config.Providers = [
        localClaudeProvider("claude-one", "Claude One", firstConfigDir),
        localClaudeProvider("claude-two", "Claude Two", secondConfigDir)
      ];

      const compiled = await compileCoreGatewayConfig(
        config,
        "raw-trace-token",
        "billing-usage-token",
        "core-auth-token"
      );
      const plugins = compiled.providerPlugins.filter((plugin) =>
        plugin.key === firstPlugin.key || plugin.key === secondPlugin.key
      );
      const firstCompiled = plugins.find((plugin) => plugin.key === firstPlugin.key);
      const secondCompiled = plugins.find((plugin) => plugin.key === secondPlugin.key);

      assert.equal(firstCompiled.auth.headers.authorization, "Bearer first-live-access-token");
      assert.deepEqual(firstCompiled.localAgent, {
        configDir: firstConfigDir,
        kind: "claude-code"
      });
      assert.equal(secondCompiled.auth.headers.authorization, "Bearer second-live-access-token");
      assert.deepEqual(secondCompiled.localAgent, {
        configDir: secondConfigDir,
        kind: "claude-code"
      });
    });
  });
});

test("core gateway compiler reads one Claude Code source once for its provider plugins", async () => {
  await withClaudeCodeHome(async (home) => {
    await withPlatform("linux", async () => {
      const configDir = path.join(home, ".claude-two");
      const credentialFile = writeClaudeCredentialsAt(configDir, {
        accessToken: "second-live-access-token"
      });
      const plugin = claudeCodeOauthProviderPlugin();
      const internalPlugin = {
        ...plugin,
        auth: {
          ...plugin.auth,
          headers: { ...plugin.auth.headers }
        },
        key: `${plugin.key}-internal`
      };
      const config = createDefaultAppConfig();
      config.providerPlugins = [plugin, internalPlugin];
      config.Providers = [
        localClaudeProvider("claude-code-api", "Claude Code API", configDir)
      ];

      await withReadFileCount(credentialFile, async (readCount) => {
        await compileCoreGatewayConfig(
          config,
          "raw-trace-token",
          "billing-usage-token",
          "core-auth-token"
        );

        assert.equal(readCount(), 1);
      });
    });
  });
});

test("core gateway compiler drops a Claude Code credential snapshot when the provider source changes", async () => {
  await withClaudeCodeHome(async (home) => {
    await withPlatform("linux", async () => {
      const staleConfigDir = path.join(home, ".claude-one");
      const currentConfigDir = path.join(home, ".claude-two");
      mkdirSync(staleConfigDir, { recursive: true });
      mkdirSync(currentConfigDir, { recursive: true });

      const plugin = claudeCodeOauthProviderPlugin();
      plugin.providerName = "Claude One";
      plugin.localAgent = {
        configDir: staleConfigDir,
        kind: "claude-code"
      };
      const config = createDefaultAppConfig();
      config.providerPlugins = [plugin];
      config.Providers = [
        localClaudeProvider("claude-one", "Claude One", currentConfigDir)
      ];

      const compiled = await compileCoreGatewayConfig(
        config,
        "raw-trace-token",
        "billing-usage-token",
        "core-auth-token"
      );
      const compiledPlugin = compiled.providerPlugins.find((item) =>
        item.key === plugin.key
      );

      assert.equal(
        compiledPlugin.auth.headers.authorization,
        undefined
      );
      assert.deepEqual(
        compiledPlugin.auth.headers["anthropic-beta"],
        {
          default: "oauth-2025-04-20",
          from: "request.headers.anthropic-beta"
        }
      );
      assert.deepEqual(compiledPlugin.localAgent, {
        configDir: currentConfigDir,
        kind: "claude-code"
      });

      const [hook] = createGatewayPlugin({
        config: { providerPlugins: [compiledPlugin] }
      }).providerHooks;
      const result = await hook.authenticate({
        upstreamRequest: {
          headers: {},
          method: "POST",
          url: "https://api.anthropic.com/v1/messages"
        }
      });
      assert.deepEqual(result, {
        error: "Claude Code access token was not found.",
        ok: false
      });
    });
  });
});

test("core gateway compiler preserves a Claude Code snapshot for equivalent source paths", async () => {
  await withClaudeCodeHome(async (home) => {
    await withPlatform("linux", async () => {
      const configDir = path.join(home, ".claude-two");
      mkdirSync(configDir, { recursive: true });

      const plugin = claudeCodeOauthProviderPlugin();
      plugin.localAgent = {
        configDir: `${configDir}${path.sep}.`,
        kind: "claude-code"
      };
      const config = createDefaultAppConfig();
      config.providerPlugins = [plugin];
      config.Providers = [
        localClaudeProvider("claude-code-api", "Claude Code API", configDir)
      ];

      const compiled = await compileCoreGatewayConfig(
        config,
        "raw-trace-token",
        "billing-usage-token",
        "core-auth-token"
      );
      const compiledPlugin = compiled.providerPlugins.find((item) =>
        item.key === plugin.key
      );

      assert.equal(
        compiledPlugin.auth.headers.authorization,
        "Bearer stale-imported-access-token"
      );
      assert.deepEqual(compiledPlugin.localAgent, {
        configDir,
        kind: "claude-code"
      });
    });
  });
});

test("core gateway compiler isolates Codex runtime credentials by provider CODEX_HOME", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccr-codex-compiler-test-"));
  const firstConfigDir = path.join(root, "codex-one");
  const secondConfigDir = path.join(root, "codex-two");
  writeCodexAuth(firstConfigDir, "first-live-access-token");
  writeCodexAuth(secondConfigDir, "second-live-access-token");
  const previousInternalHome = process.env.CCR_INTERNAL_HOME_DIR;
  process.env.CCR_INTERNAL_HOME_DIR = path.join(root, "process-home");

  try {
    const firstPlugin = codexOauthProviderPlugin("codex-one", "Codex One", "first-stale-access-token");
    firstPlugin.localAgent = { configDir: secondConfigDir, kind: "codex" };
    const secondPlugin = codexOauthProviderPlugin("codex-two", "Codex Two", "second-stale-access-token");
    secondPlugin.localAgent = { configDir: firstConfigDir, kind: "codex" };
    const config = createDefaultAppConfig();
    config.providerPlugins = [firstPlugin, secondPlugin];
    config.Providers = [
      localCodexProvider("codex-one", "Codex One", firstConfigDir),
      localCodexProvider("codex-two", "Codex Two", secondConfigDir)
    ];

    const compiled = await compileCoreGatewayConfig(
      config,
      "raw-trace-token",
      "billing-usage-token",
      "core-auth-token"
    );
    const firstCompiled = compiled.providerPlugins.find((plugin) => plugin.key === firstPlugin.key);
    const secondCompiled = compiled.providerPlugins.find((plugin) => plugin.key === secondPlugin.key);

    assert.equal(firstCompiled.codexOauth.accessToken, "first-live-access-token");
    assert.deepEqual(firstCompiled.localAgent, {
      configDir: firstConfigDir,
      kind: "codex"
    });
    assert.equal(secondCompiled.codexOauth.accessToken, "second-live-access-token");
    assert.deepEqual(secondCompiled.localAgent, {
      configDir: secondConfigDir,
      kind: "codex"
    });
  } finally {
    restoreEnv("CCR_INTERNAL_HOME_DIR", previousInternalHome);
    rmSync(root, { force: true, recursive: true });
  }
});

test("core gateway compiler reads one Codex source once for its provider plugins", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccr-codex-compiler-test-"));
  const configDir = path.join(root, "codex-two");
  const authFile = path.join(configDir, "auth.json");
  writeCodexAuth(configDir, "second-live-access-token");
  const previousInternalHome = process.env.CCR_INTERNAL_HOME_DIR;
  process.env.CCR_INTERNAL_HOME_DIR = path.join(root, "process-home");

  try {
    const plugin = codexOauthProviderPlugin(
      "codex-two",
      "Codex Two",
      "stale-access-token"
    );
    const internalPlugin = {
      ...plugin,
      codexOauth: { ...plugin.codexOauth },
      key: `${plugin.key}-internal`
    };
    const config = createDefaultAppConfig();
    config.providerPlugins = [plugin, internalPlugin];
    config.Providers = [
      localCodexProvider("codex-two", "Codex Two", configDir)
    ];

    await withReadFileCount(authFile, async (readCount) => {
      await compileCoreGatewayConfig(
        config,
        "raw-trace-token",
        "billing-usage-token",
        "core-auth-token"
      );

      assert.equal(readCount(), 1);
    });
  } finally {
    restoreEnv("CCR_INTERNAL_HOME_DIR", previousInternalHome);
    rmSync(root, { force: true, recursive: true });
  }
});

test("core gateway compiler does not read Codex credentials to recover a configured plugin", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccr-codex-compiler-test-"));
  const configDir = path.join(root, "codex-two");
  const authFile = path.join(configDir, "auth.json");
  writeCodexAuth(configDir, "second-live-access-token");
  const previousInternalHome = process.env.CCR_INTERNAL_HOME_DIR;
  process.env.CCR_INTERNAL_HOME_DIR = path.join(root, "process-home");

  try {
    const plugin = {
      ...codexOauthProviderPlugin(
        "codex-two",
        "Codex Two",
        "stale-access-token"
      ),
      enabled: false
    };
    const config = createDefaultAppConfig();
    config.providerPlugins = [plugin];
    config.Providers = [
      localCodexProvider("codex-two", "Codex Two", configDir)
    ];

    await withReadFileCount(authFile, async (readCount) => {
      await compileCoreGatewayConfig(
        config,
        "raw-trace-token",
        "billing-usage-token",
        "core-auth-token"
      );

      assert.equal(readCount(), 0);
    });
  } finally {
    restoreEnv("CCR_INTERNAL_HOME_DIR", previousInternalHome);
    rmSync(root, { force: true, recursive: true });
  }
});

test("core gateway compiler prefers an exact local provider name over another provider capability alias", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccr-codex-compiler-test-"));
  const exactConfigDir = path.join(root, "exact-provider");
  const aliasConfigDir = path.join(root, "alias-provider");
  mkdirSync(exactConfigDir, { recursive: true });
  mkdirSync(aliasConfigDir, { recursive: true });
  const previousInternalHome = process.env.CCR_INTERNAL_HOME_DIR;
  process.env.CCR_INTERNAL_HOME_DIR = path.join(root, "process-home");

  try {
    const exactProvider = localCodexProvider(
      "exact-provider",
      "Alias Provider::openai_responses",
      exactConfigDir
    );
    const aliasProvider = {
      ...localCodexProvider("alias-provider", "Alias Provider", aliasConfigDir),
      capabilities: [{
        baseUrl: "https://chatgpt.com/backend-api/codex",
        type: "openai_responses"
      }]
    };
    const plugin = codexOauthProviderPlugin(
      "exact-provider",
      exactProvider.name,
      "stale-access-token"
    );
    plugin.localAgent = { configDir: exactConfigDir, kind: "codex" };
    const config = createDefaultAppConfig();
    config.providerPlugins = [plugin];
    config.Providers = [aliasProvider, exactProvider];

    const compiled = await compileCoreGatewayConfig(
      config,
      "raw-trace-token",
      "billing-usage-token",
      "core-auth-token"
    );
    const compiledPlugin = compiled.providerPlugins.find((item) => item.key === plugin.key);

    assert.deepEqual(compiledPlugin.localAgent, {
      configDir: exactConfigDir,
      kind: "codex"
    });
    assert.equal(compiledPlugin.providerName, "exact-provider");
  } finally {
    restoreEnv("CCR_INTERNAL_HOME_DIR", previousInternalHome);
    rmSync(root, { force: true, recursive: true });
  }
});

test("core gateway compiler uses the local plugin key when its provider alias matches another display name", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccr-codex-compiler-test-"));
  const exactConfigDir = path.join(root, "exact-provider");
  const aliasConfigDir = path.join(root, "alias-provider");
  mkdirSync(exactConfigDir, { recursive: true });
  mkdirSync(aliasConfigDir, { recursive: true });
  const previousInternalHome = process.env.CCR_INTERNAL_HOME_DIR;
  process.env.CCR_INTERNAL_HOME_DIR = path.join(root, "process-home");

  try {
    const exactProvider = localCodexProvider(
      "exact-provider",
      "Alias Provider::openai_responses",
      exactConfigDir
    );
    const aliasProvider = {
      ...localCodexProvider("alias-provider", "Alias Provider", aliasConfigDir),
      capabilities: [{
        baseUrl: "https://chatgpt.com/backend-api/codex",
        type: "openai_responses"
      }]
    };
    const plugin = codexOauthProviderPlugin(
      "alias-provider",
      "Alias Provider::openai_responses",
      "stale-access-token"
    );
    plugin.localAgent = { configDir: aliasConfigDir, kind: "codex" };
    const config = createDefaultAppConfig();
    config.providerPlugins = [plugin];
    config.Providers = [exactProvider, aliasProvider];

    const compiled = await compileCoreGatewayConfig(
      config,
      "raw-trace-token",
      "billing-usage-token",
      "core-auth-token"
    );
    const compiledPlugin = compiled.providerPlugins.find((item) => item.key === plugin.key);

    assert.deepEqual(compiledPlugin.localAgent, {
      configDir: aliasConfigDir,
      kind: "codex"
    });
    assert.equal(compiledPlugin.providerName, "alias-provider::openai_responses");
  } finally {
    restoreEnv("CCR_INTERNAL_HOME_DIR", previousInternalHome);
    rmSync(root, { force: true, recursive: true });
  }
});

test("core gateway compiler drops Codex credential snapshots when the provider source changes", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccr-codex-compiler-test-"));
  const staleConfigDir = path.join(root, "codex-one");
  const currentConfigDir = path.join(root, "codex-two");
  mkdirSync(staleConfigDir, { recursive: true });
  mkdirSync(currentConfigDir, { recursive: true });
  const previousInternalHome = process.env.CCR_INTERNAL_HOME_DIR;
  process.env.CCR_INTERNAL_HOME_DIR = path.join(root, "process-home");

  try {
    const plugin = codexOauthProviderPlugin(
      "codex-one",
      "Codex One",
      "stale-access-token"
    );
    plugin.codexOauth.accountId = "stale-account-id";
    plugin.codexOauth.account_id = "stale-account-id-alias";
    plugin.codexOauth.access_token = "stale-access-token-alias";
    plugin.codexOauth.refreshToken = "stale-refresh-token";
    plugin.codexOauth.refresh_token = "stale-refresh-token-alias";
    plugin.auth = {
      headers: {
        Authorization: "Bearer stale-header-access-token",
        "ChatGPT-Account-Id": "stale-header-account-id",
        "X-OpenAI-Fedramp": "true",
        "x-preserved-header": "preserved"
      }
    };
    plugin.localAgent = { configDir: staleConfigDir, kind: "codex" };
    const config = createDefaultAppConfig();
    config.providerPlugins = [plugin];
    config.Providers = [
      localCodexProvider("codex-one", "Codex One", currentConfigDir)
    ];

    const compiled = await compileCoreGatewayConfig(
      config,
      "raw-trace-token",
      "billing-usage-token",
      "core-auth-token"
    );
    const compiledPlugin = compiled.providerPlugins.find((item) =>
      item.key === plugin.key
    );

    assert.equal(compiledPlugin.codexOauth.accessToken, undefined);
    assert.equal(compiledPlugin.codexOauth.access_token, undefined);
    assert.equal(compiledPlugin.codexOauth.refreshToken, undefined);
    assert.equal(compiledPlugin.codexOauth.refresh_token, undefined);
    assert.equal(compiledPlugin.codexOauth.accountId, undefined);
    assert.equal(compiledPlugin.codexOauth.account_id, undefined);
    assert.equal(compiledPlugin.codexOauth.refreshIfMissingAccessToken, true);
    assert.equal(compiledPlugin.codexOauth.required, true);
    assert.equal(compiledPlugin.auth.headers.Authorization, undefined);
    assert.equal(compiledPlugin.auth.headers["ChatGPT-Account-Id"], undefined);
    assert.equal(compiledPlugin.auth.headers["X-OpenAI-Fedramp"], undefined);
    assert.equal(
      compiledPlugin.auth.headers["x-preserved-header"],
      "preserved"
    );
    assert.deepEqual(compiledPlugin.localAgent, {
      configDir: currentConfigDir,
      kind: "codex"
    });
  } finally {
    restoreEnv("CCR_INTERNAL_HOME_DIR", previousInternalHome);
    rmSync(root, { force: true, recursive: true });
  }
});

test("core gateway compiler recovers a missing Codex plugin from the provider CODEX_HOME", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccr-codex-compiler-test-"));
  const configDir = path.join(root, "codex-two");
  writeCodexAuth(configDir, "second-live-access-token");
  const previousInternalHome = process.env.CCR_INTERNAL_HOME_DIR;
  process.env.CCR_INTERNAL_HOME_DIR = path.join(root, "process-home");

  try {
    const config = createDefaultAppConfig();
    config.providerPlugins = [];
    config.Providers = [localCodexProvider("codex-two", "Codex Two", configDir)];

    const compiled = await compileCoreGatewayConfig(
      config,
      "raw-trace-token",
      "billing-usage-token",
      "core-auth-token"
    );
    const plugin = compiled.providerPlugins.find((item) =>
      item.key.includes("codex-oauth-recovered")
    );

    assert.equal(plugin.codexOauth.accessToken, "second-live-access-token");
    assert.deepEqual(plugin.localAgent, {
      configDir,
      kind: "codex"
    });
  } finally {
    restoreEnv("CCR_INTERNAL_HOME_DIR", previousInternalHome);
    rmSync(root, { force: true, recursive: true });
  }
});

test("Grok local agent request hook removes unsupported Responses tools and stale tool choice", () => {
  const [hook] = createGatewayPlugin({
    config: {
      providerPlugins: [grokOauthProviderPlugin()]
    }
  }).providerHooks;
  const requestResult = hook.transformRequest({
    model: "grok-4.5",
    upstreamRequest: {
      body: {
        parallel_tool_calls: true,
        tool_choice: { type: "tool", name: "multi_agent_v1" },
        tools: [
          { type: "namespace", name: "multi_agent_v1" },
          { type: "function", name: "exec_command" }
        ]
      },
      headers: {},
      method: "POST",
      url: "https://cli-chat-proxy.grok.com/v1/responses"
    }
  });

  assert.equal(requestResult.ok, true);
  assert.deepEqual(requestResult.value.body.tools, [{ type: "function", name: "exec_command" }]);
  assert.equal(requestResult.value.body.tool_choice, undefined);
  assert.equal(requestResult.value.body.parallel_tool_calls, true);
});

test("core gateway config installs the local agent dynamic auth runtime hook when OAuth plugins are present", async () => {
  const config = createDefaultAppConfig();
  config.providerPlugins = [grokOauthProviderPlugin()];
  config.Providers = [
    {
      api_base_url: "https://cli-chat-proxy.grok.com/v1",
      api_key: "ccr-local-agent-login",
      id: "grok-cli-api",
      models: ["grok-4.5"],
      name: "Grok CLI API",
      type: "openai_responses"
    }
  ];

  const compiled = await compileCoreGatewayConfig(
    config,
    "raw-trace-token",
    "billing-usage-token",
    "core-auth-token"
  );
  const plugins = Array.isArray(compiled.plugins) ? compiled.plugins : [];
  const localAgentAuthPlugin = plugins.find((plugin) => plugin.key === "ccr-local-agent-auth-provider-hooks");

  assert.ok(localAgentAuthPlugin);
  assert.match(localAgentAuthPlugin.modulePath, /local-agent-auth-provider-hook\.js$/);
});

test("core gateway config removes Grok unsupported Responses options through declarative request transforms", async (t) => {
  await withGrokHome(t, async (grokHome) => {
    writeGrokAuth(grokHome, {
      expires_at: "2099-01-01T00:00:00Z",
      key: "live-grok-access-token",
      oidc_client_id: "grok-client-id",
      oidc_issuer: "https://auth.x.ai",
      refresh_token: "grok-refresh-token"
    });
    const plugin = grokOauthProviderPlugin();
    plugin.request.bodyRemove = ["metadata"];

    const config = createDefaultAppConfig();
    config.providerPlugins = [plugin];
    config.Providers = [
      {
        api_base_url: "https://cli-chat-proxy.grok.com/v1",
        api_key: "ccr-local-agent-login",
        id: "grok-cli-api",
        models: ["grok-4.5"],
        name: "Grok CLI API",
        type: "openai_responses"
      }
    ];

    const compiled = await compileCoreGatewayConfig(
      config,
      "raw-trace-token",
      "billing-usage-token",
      "core-auth-token"
    );
    const providerPlugins = Array.isArray(compiled.providerPlugins) ? compiled.providerPlugins : [];
    const grokPlugin = providerPlugins.find((value) => value.key === "ccr-local-agent-grok-cli-api-grok-cli-oauth");

    assert.ok(grokPlugin);
    assert.deepEqual(grokPlugin.request.bodyRemove, ["metadata", "external_web_access"]);
  });
});

test("local agent OAuth plugin detector only matches managed OAuth imports", () => {
  assert.equal(isLocalAgentOauthProviderPlugin(grokOauthProviderPlugin()), true);
  assert.equal(isLocalAgentOauthProviderPlugin({
    key: "ccr-local-agent-grok-cli-api-grok-cli-api-key"
  }), false);
  assert.equal(isLocalAgentOauthProviderPlugin({
    key: "external-grok-cli-oauth"
  }), false);
});

function grokOauthProviderPlugin() {
  return {
    auth: {
      headers: {
        authorization: "Bearer imported-stale-token"
      },
      removeHeaders: ["x-api-key"],
      strict: true
    },
    key: "ccr-local-agent-grok-cli-api-grok-cli-oauth",
    providerName: "Grok CLI API",
    request: {
      headers: {
        "x-grok-client-identifier": "xai-grok-cli",
        "x-grok-client-version": "0.2.93",
        "x-grok-model-override": "{{ model }}"
      },
      strict: true
    }
  };
}

function claudeCodeOauthProviderPlugin() {
  return {
    auth: {
      headers: {
        authorization: "Bearer stale-imported-access-token",
        "anthropic-beta": "oauth-2025-04-20"
      },
      removeHeaders: ["x-api-key"],
      strict: true
    },
    key: "ccr-local-agent-claude-code-api-claude-code-oauth",
    providerName: "Claude Code API"
  };
}

async function withClaudeCodeHome(run) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ccr-claude-code-hook-test-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await run(home);
  } finally {
    restoreEnv("HOME", previousHome);
    rmSync(home, { force: true, recursive: true });
  }
}

async function withPlatform(platform, run) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform
  });
  try {
    await run();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

// Forces the macOS Keychain lookup to miss so the scan falls back to the file
// credentials this test controls, regardless of the host's real Keychain state.
async function withFakeSecurityFailure(run) {
  await withFakeSecurityScript("exit 44\n", run);
}

async function withFakeSecurityScript(body, run) {
  const binDir = mkdtempSync(path.join(os.tmpdir(), "ccr-claude-code-security-bin-"));
  const securityPath = path.join(binDir, "security");
  const previousPath = process.env.PATH;
  const previousUser = process.env.USER;
  writeFileSync(securityPath, `#!/bin/sh\n${body}`);
  chmodSync(securityPath, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
  process.env.USER = "ccr-test-user";
  try {
    await run();
  } finally {
    restoreEnv("PATH", previousPath);
    restoreEnv("USER", previousUser);
    rmSync(binDir, { force: true, recursive: true });
  }
}

function writeClaudeCredentials(home, credentials) {
  return writeClaudeCredentialsAt(path.join(home, ".claude"), credentials);
}

function writeClaudeCredentialsAt(directory, credentials) {
  const credentialFile = path.join(directory, ".credentials.json");
  mkdirSync(directory, { recursive: true });
  writeFileSync(credentialFile, JSON.stringify(credentials, null, 2));
  return credentialFile;
}

function localClaudeProvider(id, name, configDir) {
  return {
    api_base_url: "https://api.anthropic.com",
    api_key: "ccr-local-agent-login",
    id,
    localAgent: { configDir, kind: "claude-code" },
    models: ["claude-sonnet-5"],
    name,
    type: "anthropic_messages"
  };
}

function codexOauthProviderPlugin(id, providerName, accessToken) {
  return {
    codexOauth: {
      accessToken,
      refreshIfMissingAccessToken: true,
      required: true
    },
    key: `ccr-local-agent-${id}-codex-oauth`,
    providerName
  };
}

function localCodexProvider(id, name, configDir) {
  return {
    api_base_url: "https://chatgpt.com/backend-api/codex",
    api_key: "ccr-local-agent-login",
    id,
    localAgent: { configDir, kind: "codex" },
    models: ["gpt-5-codex"],
    name,
    type: "openai_responses"
  };
}

function writeCodexAuth(configDir, accessToken) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, "auth.json"), JSON.stringify({
    tokens: { access_token: accessToken }
  }));
}

async function withReadFileCount(sourceFile, run) {
  const originalReadFileSync = fs.readFileSync;
  const normalizedSourceFile = path.resolve(sourceFile);
  let count = 0;
  fs.readFileSync = function countedReadFileSync(file, ...args) {
    if (path.resolve(String(file)) === normalizedSourceFile) {
      count += 1;
    }
    return originalReadFileSync.call(this, file, ...args);
  };
  syncBuiltinESMExports();
  try {
    await run(() => count);
  } finally {
    fs.readFileSync = originalReadFileSync;
    syncBuiltinESMExports();
  }
}

async function withGrokHome(t, run) {
  const previousGrokHome = process.env.GROK_HOME;
  const previousGrokAuthFile = process.env.GROK_AUTH_FILE;
  const previousGrokCliVersion = process.env.GROK_CLI_VERSION;
  const grokHome = mkdtempSync(path.join(os.tmpdir(), "ccr-grok-hook-test-"));
  process.env.GROK_HOME = grokHome;
  process.env.GROK_CLI_VERSION = "0.2.93";
  delete process.env.GROK_AUTH_FILE;
  try {
    await run(grokHome);
  } finally {
    restoreEnv("GROK_HOME", previousGrokHome);
    restoreEnv("GROK_AUTH_FILE", previousGrokAuthFile);
    restoreEnv("GROK_CLI_VERSION", previousGrokCliVersion);
    rmSync(grokHome, { force: true, recursive: true });
  }
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function writeGrokAuth(grokHome, auth) {
  writeFileSync(path.join(grokHome, "auth.json"), JSON.stringify({
    "https://auth.x.ai::test-account": auth
  }, null, 2));
}
