import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codexDefaultBaseUrl } from "@ccr/core/agents/local-providers/codex.ts";
import {
  hasAutoFetchModelProviders,
  refreshAutoFetchProviderModels,
  runProviderModelAutoRefreshNow
} from "@ccr/core/providers/model-auto-refresh.ts";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function testConfig(overrides = {}) {
  return {
    APIKEY: "",
    APIKEYS: [],
    API_TIMEOUT_MS: 600000,
    CUSTOM_ROUTER_PATH: "",
    HOST: "127.0.0.1",
    PORT: 3456,
    Providers: [
      {
        api_base_url: "https://api.provider.test/v1",
        api_key: "sk-provider",
        autoFetchModels: true,
        autoFetchKnownModels: ["alpha"],
        id: "provider",
        models: ["alpha"],
        name: "Provider",
        type: "openai_chat_completions"
      },
      {
        api_base_url: "https://api.other.test/v1",
        autoFetchModels: false,
        id: "other",
        models: ["omega"],
        name: "Other",
        type: "openai_chat_completions"
      }
    ],
    Router: {
      fallback: { mode: "off", models: [], retryCount: 0 },
      rules: []
    },
    profile: {
      enabled: true,
      profiles: [
        {
          agent: "codex",
          availableModels: ["Provider/alpha"],
          enabled: true,
          id: "work",
          model: "Provider/alpha",
          name: "Work",
          scope: "ccr",
          surface: "cli"
        },
        {
          agent: "codex",
          availableModels: ["Other/omega"],
          enabled: true,
          id: "other",
          model: "Other/omega",
          name: "Other Work",
          scope: "ccr",
          surface: "cli"
        },
        {
          agent: "claude-code",
          enabled: true,
          id: "all",
          model: "Provider/alpha",
          name: "All Models",
          scope: "ccr",
          surface: "cli"
        }
      ]
    },
    providerPlugins: [],
    virtualModelProfiles: [],
    ...overrides
  };
}

test("auto model refresh adds new provider models and extends matching profile allowlists", async () => {
  const config = testConfig();
  const calls = [];

  const result = await refreshAutoFetchProviderModels(config, {
    probeProvider: async (request) => {
      calls.push(request);
      return {
        capabilities: [],
        modelDisplayNames: {
          beta: "Beta"
        },
        models: ["alpha", "beta"],
        normalizedBaseUrl: request.baseUrl,
        protocols: []
      };
    }
  });

  assert.equal(result.changed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].apiKey, "sk-provider");
  assert.equal(calls[0].mode, "models");
  assert.equal(calls[0].forceRefresh, true);
  assert.deepEqual(result.config.Providers[0].models, ["alpha", "beta"]);
  assert.deepEqual(result.config.Providers[0].autoFetchKnownModels, ["alpha", "beta"]);
  assert.deepEqual(result.config.Providers[0].modelDisplayNames, { beta: "Beta" });
  assert.deepEqual(result.config.Providers[1].models, ["omega"]);
  assert.deepEqual(result.config.profile.profiles[0].availableModels, ["Provider/alpha", "Provider/beta"]);
  assert.deepEqual(result.config.profile.profiles[1].availableModels, ["Other/omega"]);
  assert.equal(result.config.profile.profiles[2].availableModels, undefined);
  assert.equal(result.profileAllowlistsUpdated, 1);
  assert.deepEqual(result.providers[0].addedModels, ["beta"]);
});

test("auto model refresh initializes a known model baseline before adding remote-only models", async () => {
  const config = testConfig({
    Providers: [
      {
        api_base_url: "https://api.provider.test/v1",
        api_key: "sk-provider",
        autoFetchModels: true,
        id: "provider",
        models: ["alpha"],
        name: "Provider",
        type: "openai_chat_completions"
      }
    ]
  });

  const result = await refreshAutoFetchProviderModels(config, {
    probeProvider: async (request) => ({
      capabilities: [],
      models: ["alpha", "beta"],
      normalizedBaseUrl: request.baseUrl,
      protocols: []
    })
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.config.Providers[0].models, ["alpha"]);
  assert.deepEqual(result.config.Providers[0].autoFetchKnownModels, ["alpha", "beta"]);
  assert.equal(result.profileAllowlistsUpdated, 0);
  assert.deepEqual(result.providers[0].addedModels, []);
});

test("auto model refresh does not re-add known models removed by the user", async () => {
  const config = testConfig({
    Providers: [
      {
        api_base_url: "https://api.provider.test/v1",
        api_key: "sk-provider",
        autoFetchModels: true,
        autoFetchKnownModels: ["alpha", "beta"],
        id: "provider",
        models: ["alpha"],
        name: "Provider",
        type: "openai_chat_completions"
      }
    ]
  });

  const result = await refreshAutoFetchProviderModels(config, {
    probeProvider: async (request) => ({
      capabilities: [],
      models: ["alpha", "beta", "gamma"],
      normalizedBaseUrl: request.baseUrl,
      protocols: []
    })
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.config.Providers[0].models, ["alpha", "gamma"]);
  assert.deepEqual(result.config.Providers[0].autoFetchKnownModels, ["alpha", "beta", "gamma"]);
  assert.deepEqual(result.config.profile.profiles[0].availableModels, ["Provider/alpha", "Provider/gamma"]);
  assert.deepEqual(result.providers[0].addedModels, ["gamma"]);
});

test("auto model refresh hot-applies saved agent profiles after the switch is enabled", async () => {
  const config = testConfig();
  const savedConfigs = [];
  const hotAppliedConfigs = [];

  const result = await runProviderModelAutoRefreshNow({
    loadConfig: async () => config,
    onConfigChanged: async (nextConfig, refreshResult) => {
      hotAppliedConfigs.push({ config: nextConfig, result: refreshResult });
    },
    probeProvider: async (request) => ({
      capabilities: [],
      models: ["alpha", "beta"],
      normalizedBaseUrl: request.baseUrl,
      protocols: []
    }),
    saveConfig: async (nextConfig) => {
      savedConfigs.push(nextConfig);
      return nextConfig;
    }
  });

  assert.equal(result.changed, true);
  assert.equal(savedConfigs.length, 1);
  assert.equal(hotAppliedConfigs.length, 1);
  assert.deepEqual(savedConfigs[0].Providers[0].models, ["alpha", "beta"]);
  assert.deepEqual(savedConfigs[0].profile.profiles[0].availableModels, ["Provider/alpha", "Provider/beta"]);
  assert.equal(hotAppliedConfigs[0].config, savedConfigs[0]);
  assert.equal(hotAppliedConfigs[0].result.config, savedConfigs[0]);
  assert.equal(hotAppliedConfigs[0].result.profileAllowlistsUpdated, 1);
});

test("auto model refresh merges fetched models into the latest config before saving", async () => {
  const baseConfig = testConfig();
  const latestConfig = clone(baseConfig);
  latestConfig.Router.rules = [{
    id: "user-added-rule",
    target: "Other/omega",
    type: "model"
  }];
  latestConfig.Providers[0].models = ["alpha", "manual"];
  latestConfig.Providers[0].autoFetchKnownModels = ["alpha"];
  const savedConfigs = [];
  const loadedConfigs = [baseConfig, latestConfig];

  const result = await runProviderModelAutoRefreshNow({
    loadConfig: async () => loadedConfigs.shift() ?? latestConfig,
    probeProvider: async (request) => ({
      capabilities: [],
      models: ["alpha", "beta"],
      normalizedBaseUrl: request.baseUrl,
      protocols: []
    }),
    saveConfig: async (nextConfig) => {
      savedConfigs.push(nextConfig);
      return nextConfig;
    }
  });

  assert.equal(result.changed, true);
  assert.equal(savedConfigs.length, 1);
  assert.deepEqual(savedConfigs[0].Router.rules, latestConfig.Router.rules);
  assert.deepEqual(savedConfigs[0].Providers[0].models, ["alpha", "manual", "beta"]);
  assert.deepEqual(savedConfigs[0].Providers[0].autoFetchKnownModels, ["alpha", "manual", "beta"]);
  assert.deepEqual(savedConfigs[0].profile.profiles[0].availableModels, ["Provider/alpha", "Provider/beta"]);
  assert.equal(result.profileAllowlistsUpdated, 1);
});

test("auto model refresh does not save stale results after the switch is disabled", async () => {
  const baseConfig = testConfig();
  const latestConfig = clone(baseConfig);
  latestConfig.Providers[0].autoFetchModels = false;
  const savedConfigs = [];
  const loadedConfigs = [baseConfig, latestConfig];

  const result = await runProviderModelAutoRefreshNow({
    loadConfig: async () => loadedConfigs.shift() ?? latestConfig,
    probeProvider: async (request) => ({
      capabilities: [],
      models: ["alpha", "beta"],
      normalizedBaseUrl: request.baseUrl,
      protocols: []
    }),
    saveConfig: async (nextConfig) => {
      savedConfigs.push(nextConfig);
      return nextConfig;
    }
  });

  assert.equal(result.changed, false);
  assert.equal(savedConfigs.length, 0);
  assert.equal(result.config, latestConfig);
  assert.deepEqual(result.config.Providers[0].models, ["alpha"]);
  assert.equal(result.config.Providers[0].autoFetchModels, false);
});

test("auto model refresh uses Codex local model catalog during hot apply", async (t) => {
  const previousCcrHome = process.env.CCR_INTERNAL_HOME_DIR;
  const previousHome = process.env.HOME;
  const home = mkdtempSync(path.join(os.tmpdir(), "ccr-codex-local-catalog-"));
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  writeFileSync(path.join(home, ".codex", "models_cache.json"), JSON.stringify({
    models: [
      {
        context_window: 272000,
        display_name: "GPT-5.1 Codex",
        max_context_window: 300000,
        slug: "gpt-5.1-codex",
        supported_reasoning_levels: [{ description: "High", effort: "high" }],
        supports_reasoning_summaries: true
      }
    ]
  }), "utf8");
  process.env.CCR_INTERNAL_HOME_DIR = home;
  process.env.HOME = home;
  t.after(() => {
    if (previousCcrHome === undefined) {
      delete process.env.CCR_INTERNAL_HOME_DIR;
    } else {
      process.env.CCR_INTERNAL_HOME_DIR = previousCcrHome;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(home, { force: true, recursive: true });
  });

  const config = testConfig({
    Providers: [
      {
        api_base_url: codexDefaultBaseUrl,
        api_key: "ccr-local-agent-login",
        autoFetchModels: true,
        autoFetchKnownModels: ["gpt-5-codex"],
        id: "codex-api",
        models: ["gpt-5-codex"],
        name: "Codex API",
        type: "openai_responses"
      }
    ],
    profile: {
      enabled: true,
      profiles: [
        {
          agent: "codex",
          availableModels: ["Codex API/gpt-5-codex"],
          enabled: true,
          id: "codex-work",
          model: "Codex API/gpt-5-codex",
          name: "Codex Work",
          scope: "ccr",
          surface: "cli"
        }
      ]
    }
  });
  const hotAppliedConfigs = [];

  const result = await runProviderModelAutoRefreshNow({
    loadConfig: async () => config,
    onConfigChanged: async (nextConfig) => {
      hotAppliedConfigs.push(nextConfig);
    },
    probeProvider: async (request) => ({
      capabilities: [],
      models: ["gpt-5-codex"],
      normalizedBaseUrl: request.baseUrl,
      protocols: []
    }),
    saveConfig: async (nextConfig) => nextConfig
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.config.Providers[0].models, ["gpt-5-codex", "gpt-5.1-codex"]);
  assert.deepEqual(result.config.Providers[0].autoFetchKnownModels, ["gpt-5-codex", "gpt-5.1-codex"]);
  assert.equal(result.config.Providers[0].modelDisplayNames["gpt-5.1-codex"], "GPT-5.1 Codex");
  assert.equal(result.config.Providers[0].modelMetadata["gpt-5.1-codex"].supportsReasoningSummaries, true);
  assert.deepEqual(result.config.profile.profiles[0].availableModels, ["Codex API/gpt-5-codex", "Codex API/gpt-5.1-codex"]);
  assert.equal(hotAppliedConfigs.length, 1);
  assert.deepEqual(hotAppliedConfigs[0].profile.profiles[0].availableModels, ["Codex API/gpt-5-codex", "Codex API/gpt-5.1-codex"]);
  assert.deepEqual(result.providers[0].addedModels, ["gpt-5.1-codex"]);
});

test("auto model refresh reads the provider CODEX_HOME model catalog", async (t) => {
  const previousCcrHome = process.env.CCR_INTERNAL_HOME_DIR;
  const root = mkdtempSync(path.join(os.tmpdir(), "ccr-codex-provider-catalog-"));
  const processHome = path.join(root, "process-home");
  const configDir = path.join(root, "codex-two");
  mkdirSync(path.join(processHome, ".codex"), { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(processHome, ".codex", "models_cache.json"), JSON.stringify({
    models: [{ slug: "default-codex-model" }]
  }), "utf8");
  writeFileSync(path.join(configDir, "models_cache.json"), JSON.stringify({
    models: [{ display_name: "Second Codex Model", slug: "second-codex-model" }]
  }), "utf8");
  process.env.CCR_INTERNAL_HOME_DIR = processHome;
  t.after(() => {
    if (previousCcrHome === undefined) {
      delete process.env.CCR_INTERNAL_HOME_DIR;
    } else {
      process.env.CCR_INTERNAL_HOME_DIR = previousCcrHome;
    }
    rmSync(root, { force: true, recursive: true });
  });

  const config = testConfig({
    Providers: [
      {
        api_base_url: codexDefaultBaseUrl,
        api_key: "ccr-local-agent-login",
        autoFetchModels: true,
        autoFetchKnownModels: ["gpt-5-codex"],
        id: "codex-two",
        localAgent: { configDir, kind: "codex" },
        models: ["gpt-5-codex"],
        name: "Codex Two",
        type: "openai_responses"
      }
    ]
  });

  const result = await refreshAutoFetchProviderModels(config, {
    probeProvider: async (request) => ({
      capabilities: [],
      models: ["gpt-5-codex"],
      normalizedBaseUrl: request.baseUrl,
      protocols: []
    })
  });

  assert.deepEqual(result.config.Providers[0].models, ["gpt-5-codex", "second-codex-model"]);
  assert.equal(result.config.Providers[0].modelDisplayNames["second-codex-model"], "Second Codex Model");
  assert.equal(result.config.Providers[0].models.includes("default-codex-model"), false);
});

test("auto model refresh is unchanged when fetched models are already configured", async () => {
  const config = testConfig();

  const result = await refreshAutoFetchProviderModels(config, {
    probeProvider: async (request) => ({
      capabilities: [],
      models: ["alpha"],
      normalizedBaseUrl: request.baseUrl,
      protocols: []
    })
  });

  assert.equal(result.changed, false);
  assert.equal(result.config, config);
  assert.equal(result.profileAllowlistsUpdated, 0);
});

test("auto model refresh uses an enabled credential when the provider has no primary key", async () => {
  const config = testConfig({
    Providers: [
      {
        api_base_url: "https://api.provider.test/v1",
        autoFetchModels: true,
        credentials: [
          { api_key: "sk-disabled", enabled: false },
          { api_key: "sk-enabled", enabled: true }
        ],
        id: "provider",
        models: ["alpha"],
        name: "Provider",
        type: "openai_chat_completions"
      }
    ]
  });

  let apiKey = "";
  await refreshAutoFetchProviderModels(config, {
    probeProvider: async (request) => {
      apiKey = request.apiKey;
      return {
        capabilities: [],
        models: ["alpha", "beta"],
        normalizedBaseUrl: request.baseUrl,
        protocols: []
      };
    }
  });

  assert.equal(apiKey, "sk-enabled");
});

test("auto model refresh uses enabled local provider plugins including protocol-scoped aliases", async () => {
  const config = testConfig({
    Providers: [
      {
        api_base_url: "https://api.provider.test/v1",
        api_key: "ccr-local-agent-login",
        autoFetchModels: true,
        autoFetchKnownModels: ["alpha"],
        id: "provider",
        models: ["alpha"],
        name: "Provider",
        type: "openai_chat_completions"
      }
    ],
    providerPlugins: [
      {
        enabled: false,
        key: "ccr-local-agent-provider-disabled",
        providerName: "Provider"
      },
      {
        key: "ccr-local-agent-provider-internal",
        providerName: "provider::openai_chat_completions"
      },
      {
        key: "external-provider-plugin",
        providerName: "Provider"
      }
    ]
  });

  let pluginKeys = [];
  await refreshAutoFetchProviderModels(config, {
    probeProvider: async (request) => {
      pluginKeys = request.providerPlugins.map((plugin) => plugin.key);
      return {
        capabilities: [],
        models: ["alpha", "beta"],
        normalizedBaseUrl: request.baseUrl,
        protocols: []
      };
    }
  });

  assert.deepEqual(pluginKeys, ["ccr-local-agent-provider-internal"]);
});

test("auto model refresh uses the provider CODEX_HOME instead of a stale plugin source", async () => {
  const configDir = "/Users/test/.codex-two";
  const config = testConfig({
    Providers: [
      {
        api_base_url: codexDefaultBaseUrl,
        api_key: "ccr-local-agent-login",
        autoFetchModels: true,
        autoFetchKnownModels: ["gpt-5-codex"],
        id: "codex-two",
        localAgent: { configDir, kind: "codex" },
        models: ["gpt-5-codex"],
        name: "Codex Two",
        type: "openai_responses"
      }
    ],
    providerPlugins: [
      {
        auth: {
          headers: {
            authorization: "Bearer stale-access-token",
            "ChatGPT-Account-Id": "stale-account-id",
            "x-preserved-header": "preserved"
          }
        },
        codexOauth: {
          accessToken: "stale-access-token",
          accountId: "stale-account-id",
          required: true
        },
        key: "ccr-local-agent-codex-two-codex-oauth",
        localAgent: { configDir: "/Users/test/.codex-one", kind: "codex" },
        providerName: "Codex Two"
      }
    ]
  });

  let providerPlugin;
  await refreshAutoFetchProviderModels(config, {
    probeProvider: async (request) => {
      [providerPlugin] = request.providerPlugins;
      return {
        capabilities: [],
        models: ["gpt-5-codex"],
        normalizedBaseUrl: request.baseUrl,
        protocols: []
      };
    }
  });

  assert.deepEqual(providerPlugin.localAgent, { configDir, kind: "codex" });
  assert.equal(providerPlugin.codexOauth.accessToken, undefined);
  assert.equal(providerPlugin.codexOauth.accountId, undefined);
  assert.equal(providerPlugin.codexOauth.required, true);
  assert.equal(providerPlugin.auth.headers.authorization, undefined);
  assert.equal(providerPlugin.auth.headers["ChatGPT-Account-Id"], undefined);
  assert.equal(providerPlugin.auth.headers["x-preserved-header"], "preserved");
});

test("auto model refresh reads the provider CODEX_HOME when the matching plugin is missing", async (t) => {
  const previousCcrHome = process.env.CCR_INTERNAL_HOME_DIR;
  const previousFetch = globalThis.fetch;
  const root = mkdtempSync(path.join(os.tmpdir(), "ccr-codex-refresh-missing-plugin-"));
  const processHome = path.join(root, "process-home");
  const defaultConfigDir = path.join(processHome, ".codex");
  const configDir = path.join(root, "codex-two");
  const defaultToken = jwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-default" },
    exp: Math.floor(Date.now() / 1000) + 3600,
    scope: "api.connectors.read api.connectors.invoke"
  });
  const selectedToken = jwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-selected" },
    exp: Math.floor(Date.now() / 1000) + 3600,
    scope: "api.connectors.read api.connectors.invoke"
  });
  mkdirSync(defaultConfigDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(defaultConfigDir, "auth.json"), JSON.stringify({
    tokens: { access_token: defaultToken, account_id: "acct-default" }
  }));
  writeFileSync(path.join(configDir, "auth.json"), JSON.stringify({
    tokens: { access_token: selectedToken, account_id: "acct-selected" }
  }));
  process.env.CCR_INTERNAL_HOME_DIR = processHome;

  const modelRequests = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (url.pathname.endsWith("/models")) {
      const authorization = headers.get("authorization");
      modelRequests.push({
        authorization,
        chatgptAccountId: headers.get("chatgpt-account-id")
      });
      const model = authorization === `Bearer ${selectedToken}`
        ? "selected-codex-model"
        : "default-codex-model";
      return new Response(JSON.stringify({ data: [{ id: model }] }), {
        headers: { "content-type": "application/json" },
        status: 200
      });
    }
    return new Response(JSON.stringify({ error: { message: "Unsupported probe" } }), {
      headers: { "content-type": "application/json" },
      status: 404
    });
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousCcrHome === undefined) {
      delete process.env.CCR_INTERNAL_HOME_DIR;
    } else {
      process.env.CCR_INTERNAL_HOME_DIR = previousCcrHome;
    }
    rmSync(root, { force: true, recursive: true });
  });

  const result = await refreshAutoFetchProviderModels(testConfig({
    Providers: [
      {
        api_base_url: codexDefaultBaseUrl,
        api_key: "ccr-local-agent-login",
        autoFetchModels: true,
        autoFetchKnownModels: ["gpt-5-codex"],
        id: "codex-two",
        localAgent: { configDir, kind: "codex" },
        models: ["gpt-5-codex"],
        name: "Codex Two",
        type: "openai_responses"
      }
    ],
    providerPlugins: []
  }));

  assert.deepEqual(modelRequests, [{
    authorization: `Bearer ${selectedToken}`,
    chatgptAccountId: "acct-selected"
  }]);
  assert.equal(result.config.Providers[0].models.includes("selected-codex-model"), true);
  assert.equal(result.config.Providers[0].models.includes("default-codex-model"), false);
});

test("auto model refresh enabled check ignores disabled providers", () => {
  assert.equal(hasAutoFetchModelProviders(testConfig()), true);
  assert.equal(hasAutoFetchModelProviders({
    Providers: [{ autoFetchModels: true, enabled: false, models: [], name: "Disabled" }]
  }), false);
});

function jwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    ""
  ].join(".");
}
