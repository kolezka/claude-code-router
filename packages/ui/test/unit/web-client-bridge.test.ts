import assert from "node:assert/strict";
import test from "node:test";

type OpenCall = { features: string; target: string; url: string };

const openCalls: OpenCall[] = [];
const rpcCalls: Array<{ args: unknown[]; method: string }> = [];
let openResult: unknown = { opener: {} };
let rpcValue: unknown = {};

// The bridge reads the auth token and installs window.ccr at import time, so the
// globals it touches have to exist before the first import. UI tests have no DOM.
const sessionValues = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  ccr: undefined,
  history: { replaceState: () => undefined, state: null },
  location: { href: "http://127.0.0.1:3458/" },
  open: (url: string, target: string, features: string) => {
    openCalls.push({ features, target, url });
    return openResult;
  },
  sessionStorage: {
    getItem: (key: string) => sessionValues.get(key) ?? null,
    setItem: (key: string, value: string) => {
      sessionValues.set(key, value);
    }
  }
};

(globalThis as unknown as { fetch: unknown }).fetch = async (_input: unknown, init: { body: string }) => {
  rpcCalls.push(JSON.parse(init.body));
  return {
    json: async () => ({ ok: true, value: rpcValue }),
    ok: true,
    status: 200
  };
};

async function loadBridge() {
  await import("@ccr/ui/web-client-bridge.ts");
  const bridge = (globalThis as unknown as { window: { ccr?: Record<string, any> } }).window.ccr;
  assert.ok(bridge, "web client bridge must install window.ccr");
  return bridge;
}

test("web bridge opens the plugin app URL resolved by the gateway in a new tab", async () => {
  const bridge = await loadBridge();
  openCalls.length = 0;
  rpcCalls.length = 0;
  openResult = { opener: {} };
  rpcValue = { title: "Panel", url: "http://127.0.0.1:3456/panel" };

  await bridge.openPluginApp("test-plugin", "panel");

  assert.deepEqual(rpcCalls, [{ args: ["test-plugin", "panel"], method: "openPluginApp" }]);
  assert.equal(openCalls.length, 1);
  assert.equal(openCalls[0].url, "http://127.0.0.1:3456/panel");
  assert.equal(openCalls[0].target, "_blank");
});

test("web bridge severs the opener on the plugin app tab", async () => {
  const bridge = await loadBridge();
  const tab = { opener: { stolen: true } };
  openCalls.length = 0;
  rpcCalls.length = 0;
  openResult = tab;
  rpcValue = { title: "Panel", url: "http://127.0.0.1:3456/panel" };

  await bridge.openPluginApp("test-plugin");

  assert.equal(tab.opener, null);
});

test("web bridge reports a plugin app tab blocked by the browser", async () => {
  const bridge = await loadBridge();
  openCalls.length = 0;
  rpcCalls.length = 0;
  openResult = null;
  rpcValue = { title: "Panel", url: "http://127.0.0.1:3456/panel" };

  await assert.rejects(
    () => bridge.openPluginApp("test-plugin"),
    /blocked/i
  );
});
