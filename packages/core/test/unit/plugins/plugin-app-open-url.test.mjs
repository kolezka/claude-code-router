import assert from "node:assert/strict";
import test from "node:test";
import { CLAUDE_DESIGN_PLUGIN_ID } from "@ccr/core/contracts/app.ts";
import { resolvePluginAppOpenUrl } from "@ccr/core/plugins/plugin-app-url.ts";

test("plugin app opening keeps an absolute http app URL unchanged", () => {
  const config = configWithPlugin({
    apps: [{ id: "docs", name: "Docs", url: "https://example.com/docs" }],
    id: "example"
  });

  assert.deepEqual(resolvePluginAppOpenUrl(config, { pluginId: "example" }), {
    title: "Docs",
    url: "https://example.com/docs"
  });
});

test("plugin app opening resolves a gateway-relative app URL against the gateway host and port", () => {
  const config = configWithPlugin({
    apps: [{ id: "panel", name: "Panel", url: "panel" }],
    id: "example"
  }, { host: "127.0.0.1", port: 4000 });

  assert.equal(
    resolvePluginAppOpenUrl(config, { pluginId: "example" }).url,
    "http://127.0.0.1:4000/panel"
  );
});

test("plugin app opening rewrites a wildcard gateway host to loopback", () => {
  const config = configWithPlugin({
    apps: [{ id: "panel", name: "Panel", url: "/panel" }],
    id: "example"
  }, { host: "0.0.0.0", port: 3456 });

  assert.equal(
    resolvePluginAppOpenUrl(config, { pluginId: "example" }).url,
    "http://127.0.0.1:3456/panel"
  );
});

test("plugin app opening brackets a bare IPv6 gateway host", () => {
  const config = configWithPlugin({
    apps: [{ id: "panel", name: "Panel", url: "/panel" }],
    id: "example"
  }, { host: "::1", port: 3456 });

  assert.equal(
    resolvePluginAppOpenUrl(config, { pluginId: "example" }).url,
    "http://[::1]:3456/panel"
  );
});

test("plugin app opening selects the requested app id", () => {
  const config = configWithPlugin({
    apps: [
      { id: "first", name: "First", url: "https://example.com/first" },
      { id: "second", name: "Second", url: "https://example.com/second" }
    ],
    id: "example"
  });

  assert.equal(
    resolvePluginAppOpenUrl(config, { appId: "second", pluginId: "example" }).url,
    "https://example.com/second"
  );
});

test("plugin app opening rejects a disabled plugin", () => {
  const config = configWithPlugin({
    apps: [{ id: "docs", name: "Docs", url: "https://example.com/docs" }],
    enabled: false,
    id: "example"
  });

  assert.throws(
    () => resolvePluginAppOpenUrl(config, { pluginId: "example" }),
    /Plugin app is not configured or enabled: example/
  );
});

test("plugin app opening rejects an unknown app id", () => {
  const config = configWithPlugin({
    apps: [{ id: "docs", name: "Docs", url: "https://example.com/docs" }],
    id: "example"
  });

  assert.throws(
    () => resolvePluginAppOpenUrl(config, { appId: "missing", pluginId: "example" }),
    /Plugin app is not configured or enabled: example/
  );
});

test("plugin app opening rejects a non-http app URL scheme", () => {
  const config = configWithPlugin({
    apps: [{ id: "docs", name: "Docs", url: "file:///etc/passwd" }],
    id: "example"
  });

  assert.throws(
    () => resolvePluginAppOpenUrl(config, { pluginId: "example" }),
    /must be an http\(s\) URL or a CCR gateway path/
  );
});

test("plugin app opening applies the Claude Design frontend override", () => {
  const config = configWithPlugin({
    apps: [{ id: "claude-design", name: "Claude Design", url: "https://claude-design.ccrdesk.top/design" }],
    config: { frontendUrl: "http://127.0.0.1:6173/design" },
    id: CLAUDE_DESIGN_PLUGIN_ID
  });

  assert.equal(
    resolvePluginAppOpenUrl(config, { pluginId: CLAUDE_DESIGN_PLUGIN_ID }).url,
    "http://127.0.0.1:6173/design"
  );
});

function configWithPlugin(plugin, gateway = { host: "127.0.0.1", port: 3456 }) {
  return {
    gateway,
    plugins: [{ enabled: true, ...plugin }]
  };
}
