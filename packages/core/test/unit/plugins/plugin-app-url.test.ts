import assert from "node:assert/strict";
import test from "node:test";
import { CLAUDE_DESIGN_PLUGIN_ID, CLAUDE_SHIP_PLUGIN_ID } from "@ccr/core/contracts/app.ts";
import { builtInPluginAppForOpen, isLegacyClaudeDesignUrl, pluginAppUrlForOpen } from "@ccr/core/plugins/plugin-app-url.ts";

const configWithIgnoredSavedDesignHtml = {
  plugins: [
    {
      config: {
        savedHtmlPath: "/tmp/Claude Design.html",
        useSavedHtml: true
      },
      enabled: true,
      id: "claude-design"
    }
  ]
} as any;

test("Claude Design app URLs classify legacy Claude Design entries as legacy", () => {
  assert.equal(isLegacyClaudeDesignUrl("https://claude.ai/discover/design"), true);
  assert.equal(isLegacyClaudeDesignUrl("https://claude.ai/design"), true);
  assert.equal(isLegacyClaudeDesignUrl("https://claude-design.ccrdesk.top/design"), false);
  assert.equal(isLegacyClaudeDesignUrl("https://example.com/discover/design"), false);
});

test("Claude Design app opening migrates legacy Design URLs to the current shell", () => {
  assert.equal(
    pluginAppUrlForOpen(
      configWithIgnoredSavedDesignHtml,
      "claude-design",
      "https://claude.ai/discover/design"
    ),
    "https://claude-design.ccrdesk.top/design"
  );
});

test("Claude Design app opening keeps current and non-Design app URLs unchanged", () => {
  assert.equal(
    pluginAppUrlForOpen(
      configWithIgnoredSavedDesignHtml,
      "claude-design",
      "https://claude-design.ccrdesk.top/design"
    ),
    "https://claude-design.ccrdesk.top/design"
  );
  assert.equal(
    pluginAppUrlForOpen(
      configWithIgnoredSavedDesignHtml,
      "claude-ship",
      "https://example.com/discover/design"
    ),
    "https://example.com/discover/design"
  );
});

test("Claude Design app opening uses configured local frontend URL", () => {
  const config = {
    plugins: [{
      config: {
        frontendUrl: "http://127.0.0.1:6173/design"
      },
      enabled: true,
      id: CLAUDE_DESIGN_PLUGIN_ID
    }]
  } as any;

  assert.equal(
    pluginAppUrlForOpen(
      config,
      CLAUDE_DESIGN_PLUGIN_ID,
      "https://claude-design.ccrdesk.top/design"
    ),
    "http://127.0.0.1:6173/design"
  );
});

test("Claude Design app opening derives local frontend URL from configured assets origin", () => {
  const config = {
    plugins: [{
      config: {
        frontendAssetsOrigin: "http://127.0.0.1:6173/"
      },
      enabled: true,
      id: CLAUDE_DESIGN_PLUGIN_ID
    }]
  } as any;

  assert.equal(
    pluginAppUrlForOpen(
      config,
      CLAUDE_DESIGN_PLUGIN_ID,
      "https://claude-design.ccrdesk.top/design"
    ),
    "http://127.0.0.1:6173/design"
  );
});

test("Claude Design app opening uses local frontend URL from environment", () => {
  withEnv("CCR_CLAUDE_DESIGN_FRONTEND_URL", "http://127.0.0.1:6173/design", () => {
    assert.equal(
      pluginAppUrlForOpen(
        configWithIgnoredSavedDesignHtml,
        CLAUDE_DESIGN_PLUGIN_ID,
        "https://claude-design.ccrdesk.top/design"
      ),
      "http://127.0.0.1:6173/design"
    );
  });
});

test("Claude Ship app opening derives local frontend URL from environment", () => {
  withEnv("CCR_CLAUDE_SHIP_FRONTEND_ORIGIN", "http://127.0.0.1:6173", () => {
    assert.equal(
      pluginAppUrlForOpen(
        { plugins: [] } as any,
        CLAUDE_SHIP_PLUGIN_ID,
        "https://claude.ai/claude-ship"
      ),
      "http://127.0.0.1:6173/claude-ship"
    );
  });
});

test("Claude Design resolves to the built-in app without installed plugin config", () => {
  const pluginApp = builtInPluginAppForOpen(CLAUDE_DESIGN_PLUGIN_ID);

  assert.equal(pluginApp?.id, "claude-design");
  assert.equal(pluginApp?.name, "Claude Design");
  assert.equal(pluginApp?.url, "https://claude-design.ccrdesk.top/design");
  assert.equal(builtInPluginAppForOpen("unknown-plugin"), undefined);
  assert.equal(builtInPluginAppForOpen(CLAUDE_DESIGN_PLUGIN_ID, "missing"), undefined);
});

function withEnv(name: string, value: string, run: () => void): void {
  const previousValue = process.env[name];
  try {
    process.env[name] = value;
    run();
  } finally {
    if (previousValue === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previousValue;
    }
  }
}
