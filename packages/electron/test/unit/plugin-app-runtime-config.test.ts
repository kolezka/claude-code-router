import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { CLAUDE_DESIGN_PLUGIN_ID, CLAUDE_SHIP_PLUGIN_ID } from "@ccr/core/contracts/app.ts";
import { configForPluginAppOpen } from "@ccr/core/plugins/plugin-app-url.ts";
import { CCR_DESKTOP_APP_ENV } from "@ccr/core/runtime/desktop-app.ts";

// These stay in the Electron suite: configForPluginAppOpen goes through
// isDesktopAppRuntime(), which needs process.versions.electron. Core's runner is plain Node.

test("Claude Design app opening injects the runtime plugin config", () => {
  withDesktopRuntime(() => {
    const config = { plugins: [] } as any;
    const runtimeConfig = configForPluginAppOpen(config, CLAUDE_DESIGN_PLUGIN_ID);
    const shipConfig = configForPluginAppOpen(config, CLAUDE_SHIP_PLUGIN_ID);

    assert.equal(config.plugins.length, 0);
    assert.equal(runtimeConfig.plugins.length, 1);
    assert.equal(runtimeConfig.plugins[0].id, CLAUDE_DESIGN_PLUGIN_ID);
    assert.equal(runtimeConfig.plugins[0].module, bundledPluginModule("claude-design"));
    assert.equal(shipConfig.plugins.length, 1);
    assert.equal(shipConfig.plugins[0].id, CLAUDE_SHIP_PLUGIN_ID);
    assert.equal(shipConfig.plugins[0].module, bundledPluginModule("claude-ship"));
    assert.equal(configForPluginAppOpen(config, "unknown-plugin"), config);
  });
});

test("Claude Design app opening fills an existing built-in plugin config without a module", () => {
  withDesktopRuntime(() => {
    const config = {
      plugins: [{
        config: { savedHtmlPath: "/tmp/Claude Design.html" },
        enabled: true,
        id: CLAUDE_DESIGN_PLUGIN_ID
      }]
    } as any;

    const runtimeConfig = configForPluginAppOpen(config, CLAUDE_DESIGN_PLUGIN_ID);

    assert.equal(config.plugins[0].module, undefined);
    assert.equal(runtimeConfig.plugins.length, 1);
    assert.equal(runtimeConfig.plugins[0].module, bundledPluginModule("claude-design"));
    assert.deepEqual(runtimeConfig.plugins[0].config, { savedHtmlPath: "/tmp/Claude Design.html" });
  });
});

function bundledPluginModule(pluginId: string): string {
  const distModule = path.resolve(process.cwd(), "packages", "electron", "dist", "bundled-plugins", pluginId, "index.cjs");
  return existsSync(distModule)
    ? distModule
    : path.resolve(process.cwd(), "packages", "electron", "bundled-plugins", pluginId, "index.cjs");
}

function withDesktopRuntime(run: () => void): void {
  const previousDesktopApp = process.env[CCR_DESKTOP_APP_ENV];
  try {
    process.env[CCR_DESKTOP_APP_ENV] = "1";
    run();
  } finally {
    if (previousDesktopApp === undefined) {
      delete process.env[CCR_DESKTOP_APP_ENV];
    } else {
      process.env[CCR_DESKTOP_APP_ENV] = previousDesktopApp;
    }
  }
}
