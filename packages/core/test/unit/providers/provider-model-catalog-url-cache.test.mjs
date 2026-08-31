import assert from "node:assert/strict";
import test from "node:test";
import { getProviderCatalogModels } from "@ccr/core/providers/model-catalog.ts";

// Guards the invariant that repeated catalog lookups must not re-parse provider
// URLs. Without memoization a single `ccr` invocation built ~70M URL objects and
// blocked the event loop for ~56s, which surfaced as slow startup and session
// timeouts.
function countUrlConstructions(run) {
  const OriginalUrl = globalThis.URL;
  let count = 0;
  class CountingUrl extends OriginalUrl {
    constructor(...args) {
      super(...args);
      count += 1;
    }
  }
  globalThis.URL = CountingUrl;
  try {
    run();
  } finally {
    globalThis.URL = OriginalUrl;
  }
  return count;
}

test("repeated catalog lookups do not re-parse provider urls", () => {
  const request = { baseUrl: "https://api.anthropic.com", name: "Default" };

  // Warm the catalog index so we measure lookups, not one-time index building.
  getProviderCatalogModels(request);

  const repeats = 200;
  const urlConstructions = countUrlConstructions(() => {
    for (let index = 0; index < repeats; index += 1) {
      getProviderCatalogModels(request);
    }
  });

  // A cached lookup parses nothing. Allow a small constant budget per call so the
  // test locks the "no per-provider rescan" contract rather than an exact number.
  assert.ok(
    urlConstructions <= repeats * 2,
    `expected cached lookups to avoid url parsing, saw ${urlConstructions} URL constructions for ${repeats} lookups`
  );
});

test("catalog lookups stay correct when served from cache", () => {
  const request = { baseUrl: "https://api.anthropic.com", providerPresetId: "anthropic" };
  const first = getProviderCatalogModels(request);
  const second = getProviderCatalogModels(request);

  assert.deepEqual(second.models, first.models);
  assert.equal(second.provider, first.provider);
  assert.equal(second.matchedBy, first.matchedBy);
});

test("distinct providers still resolve to their own catalog entries", () => {
  const anthropic = getProviderCatalogModels({ baseUrl: "https://api.anthropic.com" });
  const deepseek = getProviderCatalogModels({ baseUrl: "https://api.deepseek.com" });

  assert.notEqual(anthropic.provider, deepseek.provider);
  assert.ok(anthropic.models.length > 0);
  assert.ok(deepseek.models.length > 0);
});
