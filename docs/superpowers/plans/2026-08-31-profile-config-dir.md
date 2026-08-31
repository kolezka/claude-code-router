# Per-Profile Configuration Directory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a CCR profile write its agent configuration to a user-chosen directory (for example a dotfiles-managed `~/Development/inkitt/.claude`) instead of only `~/.claude-code-router/profiles/<slug>/` or `~/.claude`.

**Architecture:** Finish the half-built `custom` profile scope. `ProfileScope` already contains `"custom"` and the config parser already accepts it; it is unreachable only because the UI form collapses it to `"ccr"`. A new optional `ProfileConfig.configDir` field, honoured only when `scope === "custom"` and only for the `claude-code` and `codex` agents, makes the named directory *be* the agent config directory. Existing merge and backup machinery is reused unchanged; the work is in path resolution, keeping CCR out of the user's directory outside of apply, and UI exposure.

**Tech Stack:** TypeScript, Node's built-in test runner (`node --test`), React (UI), npm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-31-profile-config-dir-design.md`

## Global Constraints

- Branch: `feat/profile-config-dir`. Worktree: `/Users/me/Development/ccr-profile-config-dir`. Never edit the main checkout at `/Users/me/Development/claude-code-router`.
- `configDir` is honoured **only** when `scope === "custom"` **and** `agent` is `"claude-code"` or `"codex"`. Every other combination must behave exactly as it does today.
- When `configDir` is empty or absent, every resolved path must be byte-identical to current behaviour. This is a hard back-compat requirement with a dedicated regression test.
- The directory the user names **is** the agent config directory. Never append `<slug>`, `/claude`, `/codex`, or `/custom` to it.
- **Do not unify** `service.ts` and `launch-core.ts` resolvers. `service.ts:3721` `sanitizeProfilePathSegment` preserves case; `launch-core.ts:425` `sanitizePathSegment` lowercases. Collapsing them would change apply-side slugs and orphan existing profile directories on case-sensitive filesystems. Only the *new* predicate is shared.
- CCR must not write into the configured directory outside a normal apply. No cleanup on disable, no ToolHub cleanup.
- Tilde expansion uses `resolveUserPath`, consistent with `settingsFile` and `codexHome`.
- Language: English for all code, identifiers, comments, and commit messages. Conventional Commits, subject <= 72 chars, imperative mood.

### Test baseline (measured on this branch, 2026-08-31)

`npm run test:core` reports **953 tests, 939 pass, 9 fail** and exits 1 on a clean checkout of this branch. These 9 failures are pre-existing and unrelated to this work. Do not try to fix them; do not count them as regressions:

```
not ok 16  - Claude Code wrapper leaves the scoped profile model as an environment default
not ok 17  - Claude Code wrapper preserves an explicit model argument
not ok 256 - sync skips and restores the backup when no enabled claude-code profile opens the app
not ok 257 - sync skips and restores the backup when the only claude-code profile is disabled
not ok 260 - sync applies the gateway config for auto, app, and unset surfaces
not ok 261 - sync applies the gateway config regardless of profile scope
not ok 431 - known bundled plugins without persisted permissions receive scoped defaults
not ok 461 - legacy combined Claude Design plugin config migrates to split Design and Ship plugins
not ok 463 - Claude Design runtime plugin config resolves from the bundled plugin in CCR Desktop without persisting
```

Tests 256, 257, 260 and 261 are in the profile-service area this plan modifies. After each task, confirm the failure count is still exactly 9 and the names are unchanged. A tenth failure, or a different name, is a regression you caused.

### Commands

| Purpose | Command |
|---|---|
| Core tests | `npm run test:core` |
| UI tests | `npm run test:ui` |
| Types | `npm run typecheck` |
| Everything | `npm test` |

Tests compile to `.test-dist/` first, then run under `node --test`. There is no per-file filter through the npm scripts; run the whole package suite.

---

## File Structure

**Modified — core contract and parsing**
- `packages/core/src/contracts/app.ts` — adds `configDir` to `ProfileConfig`.
- `packages/core/src/config/config.ts` — parses `configDir` for claude-code and codex profiles.

**Modified — path resolution**
- `packages/core/src/profiles/launch-core.ts` — owns the new shared `resolveProfileConfigDir` predicate; branches both launch-side resolvers on it.
- `packages/core/src/profiles/service.ts` — imports that predicate; branches both apply-side resolvers on it; skips ToolHub cleanup for custom directories.

**Modified — UI**
- `packages/ui/src/pages/home/shared/types.ts` — `configDir` on `AddProfileDraft`.
- `packages/ui/src/pages/home/shared/options.ts` — the `custom` scope option.
- `packages/ui/src/pages/home/shared/profiles.ts` — stops collapsing `custom`; carries `configDir` through draft/config conversion; collision validation.
- `packages/ui/src/pages/home/components/profiles.tsx` — the directory field and the disabled-profile warning.
- `packages/ui/src/pages/home/shared/i18n.tsx` — new EN and ZH strings.

**Modified — tests**
- `packages/core/test/unit/profiles/profile-launch-core.test.mjs`
- `packages/core/test/integration/profiles/profile-service.test.mjs`
- `packages/ui/test/component/profiles.test.tsx`

`resolveProfileConfigDir` is deliberately placed in `launch-core.ts` rather than duplicated: `launch-core.ts` imports only `contracts/app` and the agent `profile-config` modules, so `service.ts` importing from it introduces no cycle, and the predicate never touches the profile slug where the two files legitimately differ.

---

### Task 1: Contract and config parsing for `configDir`

**Files:**
- Modify: `packages/core/src/contracts/app.ts:1513-1543`
- Modify: `packages/core/src/config/config.ts:3634-3658` (claude-code branch), `packages/core/src/config/config.ts:3696-3721` (codex branch)
- Test: `packages/core/test/integration/profiles/profile-service.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `ProfileConfig.configDir?: string`, populated by `loadAppConfig` from a profile's `configDir` key. Trimmed; absent when empty.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/integration/profiles/profile-service.test.mjs`:

```javascript
test("profile config parsing keeps configDir for claude-code and codex profiles", async () => {
  const config = createDefaultAppConfig();
  config.profile.profiles = [];
  await replacePersistedAppConfig({
    ...config,
    profile: {
      ...config.profile,
      profiles: [
        {
          agent: "claude-code",
          configDir: "  ~/Development/inkitt/.claude  ",
          enabled: true,
          id: "inkitt-claude",
          model: "Provider/model",
          name: "Inkitt Claude",
          scope: "custom"
        },
        {
          agent: "codex",
          configDir: "~/Development/inkitt/.codex",
          enabled: false,
          id: "inkitt-codex",
          model: "Provider/model",
          name: "Inkitt Codex",
          scope: "custom"
        },
        {
          agent: "claude-code",
          configDir: "   ",
          enabled: false,
          id: "blank-dir",
          model: "Provider/model",
          name: "Blank",
          scope: "custom"
        }
      ]
    }
  });

  const loaded = await loadAppConfig();
  const byId = Object.fromEntries(loaded.profile.profiles.map((item) => [item.id, item]));
  assert.equal(byId["inkitt-claude"].configDir, "~/Development/inkitt/.claude");
  assert.equal(byId["inkitt-claude"].scope, "custom");
  assert.equal(byId["inkitt-codex"].configDir, "~/Development/inkitt/.codex");
  assert.equal(byId["blank-dir"].configDir, undefined);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm run test:core`
Expected: FAIL — `configDir` is `undefined` for `inkitt-claude`, because the parser drops unknown keys. Total failures 10, the new one added to the known 9.

- [ ] **Step 3: Add the field to the contract**

In `packages/core/src/contracts/app.ts`, inside `ProfileConfig` (keep the alphabetical ordering the type already uses — insert between `codexHome` and `configFormat`):

```ts
  codexHome?: string;
  configDir?: string;
  configFormat?: CodexProfileConfigFormat;
```

- [ ] **Step 4: Parse it in both profile branches**

In `packages/core/src/config/config.ts`, in the `agent === "claude-code"` branch, add this line immediately after the `...(botGateway ? { botGateway } : {}),` entry:

```ts
          ...(readString(item.configDir) ? { configDir: readString(item.configDir) } : {}),
```

Add the identical line to the codex-compatible branch, immediately after its `...(botGateway ? { botGateway } : {}),` entry.

`readString` already trims and returns `undefined` for blank strings (`config.ts:4260`), which is what the third fixture asserts.

- [ ] **Step 5: Run the test and verify it passes**

Run: `npm run test:core`
Expected: the new test passes. Failure count back to exactly 9, names unchanged.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/contracts/app.ts packages/core/src/config/config.ts packages/core/test/integration/profiles/profile-service.test.mjs
git commit -m "feat: add configDir to profile contract and config parsing"
```

---

### Task 2: Launch-side path resolution

**Files:**
- Modify: `packages/core/src/profiles/launch-core.ts:257-281`
- Test: `packages/core/test/unit/profiles/profile-launch-core.test.mjs:247-280`

**Interfaces:**
- Consumes: `ProfileConfig.configDir` from Task 1.
- Produces: `export function resolveProfileConfigDir(profile: ProfileConfig): string | undefined` — returns the expanded absolute custom directory when the profile is a `custom`-scope `claude-code` or `codex` profile with a non-blank `configDir`, otherwise `undefined`. Task 3 imports this.

- [ ] **Step 1: Write the failing test**

In `packages/core/test/unit/profiles/profile-launch-core.test.mjs`, add `resolveProfileConfigDir` to the import block from `@ccr/core/profiles/launch-core.ts`, then append:

```javascript
test("custom scope with configDir resolves to the named directory itself", () => {
  const configDir = path.join(path.sep, "tmp", "ccr-config");
  const home = process.env.HOME;
  const claudeCustom = { ...claudeProfile, configDir: "~/dotfiles/.claude", scope: "custom" };
  const codexCustom = { ...codexProfile, configDir: "~/dotfiles/.codex", scope: "custom" };

  assert.equal(resolveProfileConfigDir(claudeCustom), path.join(home, "dotfiles", ".claude"));
  assert.equal(
    resolveClaudeCodeSettingsFile(configDir, claudeCustom),
    path.join(home, "dotfiles", ".claude", "settings.json")
  );
  assert.equal(
    resolveCodexConfigFile(configDir, codexCustom),
    path.join(home, "dotfiles", ".codex", "config.toml")
  );
});

test("configDir is ignored unless scope is custom and the agent is claude-code or codex", () => {
  const configDir = path.join(path.sep, "tmp", "ccr-config");

  // ccr scope ignores configDir
  assert.equal(resolveProfileConfigDir({ ...claudeProfile, configDir: "~/dotfiles/.claude" }), undefined);
  assert.equal(
    resolveClaudeCodeSettingsFile(configDir, { ...claudeProfile, configDir: "~/dotfiles/.claude" }),
    path.join(configDir, "profiles", "claude-main", "claude", "settings.json")
  );

  // custom scope with a blank configDir keeps today's nested path
  assert.equal(resolveProfileConfigDir({ ...claudeProfile, configDir: "   ", scope: "custom" }), undefined);
  assert.equal(
    resolveClaudeCodeSettingsFile(configDir, { ...claudeProfile, configDir: "   ", scope: "custom" }),
    path.join(configDir, "profiles", "claude-main", "custom", "claude", "settings.json")
  );

  // an unsupported agent ignores configDir even on custom scope
  assert.equal(
    resolveProfileConfigDir({ ...codexProfile, agent: "workbuddy", configDir: "~/dotfiles/.wb", scope: "custom" }),
    undefined
  );
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm run test:core`
Expected: FAIL — `resolveProfileConfigDir` is not exported from `launch-core.ts`.

- [ ] **Step 3: Implement the predicate and branch both resolvers**

In `packages/core/src/profiles/launch-core.ts`, add above `ccrManagedProfileDir` (line 257):

```ts
// A custom-scope claude-code or codex profile may name its own agent config
// directory. That directory IS the config dir, so nothing is appended to it.
export function resolveProfileConfigDir(profile: ProfileConfig): string | undefined {
  if (profile.agent !== "claude-code" && profile.agent !== "codex") {
    return undefined;
  }
  if (profile.scope !== "custom") {
    return undefined;
  }
  const configDir = profile.configDir?.trim();
  return configDir ? resolveUserPath(configDir) : undefined;
}
```

Replace `resolveClaudeCodeSettingsFile` (line 263) with:

```ts
export function resolveClaudeCodeSettingsFile(configDir: string, profile: ProfileConfig): string {
  const customDir = resolveProfileConfigDir(profile);
  if (customDir) {
    return path.join(customDir, "settings.json");
  }
  if (isGeneratedProfileScope(profile.scope)) {
    return path.join(ccrManagedProfileDir(configDir, profile), "claude", "settings.json");
  }
  return resolveUserPath(profile.settingsFile || "~/.claude/settings.json");
}
```

Replace `resolveCodexConfigFile` (line 270) with:

```ts
export function resolveCodexConfigFile(configDir: string, profile: ProfileConfig): string {
  if (profile.agent === "zcode") {
    return resolveZcodeConfigFile(profile);
  }
  const customDir = resolveProfileConfigDir(profile);
  if (customDir) {
    return path.join(customDir, "config.toml");
  }
  if (isGeneratedProfileScope(profile.scope)) {
    return path.join(ccrManagedProfileDir(configDir, profile), codexConfigSubdir(profile.agent), "config.toml");
  }
  const codexHome = profile.codexHome?.trim();
  if (codexHome) {
    return path.join(resolveUserPath(codexHome), "config.toml");
  }
  return resolveUserPath(profile.configFile || defaultCodexConfigFile(profile.agent));
}
```

Leave `ccrManagedProfileDir` untouched.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npm run test:core`
Expected: both new tests pass. The pre-existing test `profile config paths honor CCR, custom, and global scopes` still passes unmodified — that is the back-compat lock. Failure count exactly 9.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/profiles/launch-core.ts packages/core/test/unit/profiles/profile-launch-core.test.mjs
git commit -m "feat: resolve launch paths from a profile's custom config directory"
```

---

### Task 3: Apply-side path resolution and cross-layer parity

**Files:**
- Modify: `packages/core/src/profiles/service.ts:884-889`, `packages/core/src/profiles/service.ts:996-1008`
- Test: `packages/core/test/integration/profiles/profile-service.test.mjs`

**Interfaces:**
- Consumes: `resolveProfileConfigDir` from Task 2.
- Produces: `applyProfileConfig(config)` writes a custom-directory profile's `settings.json` into the configured directory, and reports that path in `result.clients[].path`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/integration/profiles/profile-service.test.mjs`. Add `resolveClaudeCodeSettingsFile` and `resolveProfileConfigDir` to the imports from `@ccr/core/profiles/launch-core.ts` (a new import line):

```javascript
test("custom config directory receives the merged settings file", { skip: !process.env.CCR_INTERNAL_HOME_DIR }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccr-custom-config-dir-"));
  const customDir = path.join(root, "dotfiles", ".claude");
  const settingsFile = path.join(customDir, "settings.json");
  try {
    mkdirSync(customDir, { recursive: true });
    writeFileSync(settingsFile, `${JSON.stringify({
      env: { USER_VALUE: "kept" },
      statusLine: { command: "ccstatusline", type: "command" }
    }, null, 2)}\n`);

    const profile = {
      agent: "claude-code",
      configDir: customDir,
      enabled: true,
      id: "inkitt-claude",
      model: "Provider/model",
      name: "Inkitt Claude",
      scope: "custom",
      surface: "auto"
    };

    const config = createDefaultAppConfig();
    config.APIKEY = "ccr-custom-dir-test";
    config.APIKEYS = [{
      createdAt: "2026-01-01T00:00:00.000Z",
      id: `profile:${profile.id}`,
      key: "ccr-custom-dir-test",
      name: "Profile: Claude Code"
    }];
    config.Providers = [{
      api_base_url: "https://example.test/v1",
      api_key: "provider-key",
      models: ["model"],
      name: "Provider"
    }];
    config.profile.profiles = [profile];

    const result = await applyProfileConfig(config);
    const claudeStatus = result.clients.find((client) => client.client === "claude-code");
    assert.equal(claudeStatus.ok, true);

    // The apply layer and the launch layer must agree on the path.
    assert.equal(claudeStatus.path, settingsFile);
    assert.equal(resolveClaudeCodeSettingsFile(CONFIGDIR, profile), settingsFile);
    assert.equal(resolveProfileConfigDir(profile), customDir);

    // The user's own keys survive the merge.
    const current = JSON.parse(readFileSync(settingsFile, "utf8"));
    assert.deepEqual(current.statusLine, { command: "ccstatusline", type: "command" });
    assert.equal(current.env.USER_VALUE, "kept");
    assert.equal(current.env.ANTHROPIC_MODEL, "Provider/model");

    // Nothing was written into the legacy nested location.
    assert.equal(existsSync(path.join(CONFIGDIR, "profiles", "inkitt-claude", "custom")), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a custom config directory that does not exist yet is created", { skip: !process.env.CCR_INTERNAL_HOME_DIR }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccr-custom-dir-create-"));
  // Deliberately NOT created up front - the spec says CCR creates it.
  const customDir = path.join(root, "not", "there", "yet", ".claude");
  try {
    const profile = {
      agent: "claude-code",
      configDir: customDir,
      enabled: true,
      id: "fresh-claude",
      model: "Provider/model",
      name: "Fresh Claude",
      scope: "custom",
      surface: "auto"
    };

    const config = createDefaultAppConfig();
    config.APIKEY = "ccr-custom-dir-create-test";
    config.APIKEYS = [{
      createdAt: "2026-01-01T00:00:00.000Z",
      id: `profile:${profile.id}`,
      key: "ccr-custom-dir-create-test",
      name: "Profile: Claude Code"
    }];
    config.Providers = [{
      api_base_url: "https://example.test/v1",
      api_key: "provider-key",
      models: ["model"],
      name: "Provider"
    }];
    config.profile.profiles = [profile];

    await applyProfileConfig(config);

    assert.equal(existsSync(path.join(customDir, "settings.json")), true);
    const created = JSON.parse(readFileSync(path.join(customDir, "settings.json"), "utf8"));
    assert.equal(created.env.ANTHROPIC_MODEL, "Provider/model");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
```

This second test needs no new production code — `writeFileWithBackup` already calls `mkdirSync(path.dirname(file), { recursive: true })` (`service.ts:2847`), and `path.dirname(<customDir>/settings.json)` is the custom directory. It exists to lock that behaviour in, because the spec chose auto-creation over requiring an existing directory.

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm run test:core`
Expected: FAIL — the settings file is written to `CONFIGDIR/profiles/inkitt-claude/custom/claude/settings.json`, so `claudeStatus.path` does not equal `settingsFile` and the user's file is never touched.

- [ ] **Step 3: Branch both apply-side resolvers**

In `packages/core/src/profiles/service.ts`, add `resolveProfileConfigDir` to the existing import block from `@ccr/core/profiles/launch-core` — or add a new import line if none exists:

```ts
import { resolveProfileConfigDir } from "@ccr/core/profiles/launch-core";
```

Replace `resolveClaudeCodeSettingsFile` (line 884) with:

```ts
function resolveClaudeCodeSettingsFile(profile: ProfileConfig): string {
  const customDir = resolveProfileConfigDir(profile);
  if (customDir) {
    return path.join(customDir, "settings.json");
  }
  if (isGeneratedProfileScope(profile.scope)) {
    return path.join(ccrManagedProfileDir(profile), "claude", "settings.json");
  }
  return resolveUserPath(profile.settingsFile || "~/.claude/settings.json");
}
```

Replace `resolveCodexConfigFile` (line 996) with:

```ts
function resolveCodexConfigFile(profile: ProfileConfig): string {
  if (profile.agent === "zcode") {
    return resolveZcodeConfigFile(profile);
  }
  const customDir = resolveProfileConfigDir(profile);
  if (customDir) {
    return path.join(customDir, "config.toml");
  }
  if (isGeneratedProfileScope(profile.scope)) {
    return path.join(ccrManagedProfileDir(profile), codexConfigSubdir(profile.agent), "config.toml");
  }
  const codexHome = profile.codexHome?.trim();
  if (codexHome) {
    return path.join(resolveUserPath(codexHome), "config.toml");
  }
  return resolveUserPath(profile.configFile || defaultCodexConfigFile(profile.agent));
}
```

Do **not** change `ccrManagedProfileDir` (line 1018) and do **not** replace it with the `launch-core.ts` version — see Global Constraints.

- [ ] **Step 4: Run the test and verify it passes**

Run: `npm run test:core`
Expected: the new test passes. Failure count exactly 9, names unchanged. Pay particular attention to tests 256, 257, 260 and 261 — they live in this file's area and must not change name or count.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/profiles/service.ts packages/core/test/integration/profiles/profile-service.test.mjs
git commit -m "feat: apply profile config into a custom config directory"
```

---

### Task 4: Keep CCR out of the user's directory

**Files:**
- Modify: `packages/core/src/profiles/service.ts:326-342`
- Test: `packages/core/test/integration/profiles/profile-service.test.mjs`

**Interfaces:**
- Consumes: `resolveProfileConfigDir` from Task 2.
- Produces: no new exports. `cleanupClaudeCodeToolHubArtifacts` becomes a no-op for custom-directory profiles.

**Why:** `cleanupClaudeCodeToolHubArtifacts` deletes the profile's `toolhub-mcp.json` *and* writes to the resolved settings file to strip two env keys (`service.ts:334`). It fires whenever the gateway has no available models (`service.ts:166`), for every profile regardless of enabled state. For a custom directory that write lands in the user's dotfiles. Skipping only the write would delete `toolhub-mcp.json` while leaving `settings.json` pointing at it, so both halves are skipped together and the state stays self-consistent until the next apply regenerates it.

`restoreDisabledGlobalProfile` needs no change: its `isGlobalProfile` gate (`service.ts:3030`) already returns early for `custom` scope, which is the required behaviour.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/integration/profiles/profile-service.test.mjs`:

```javascript
test("a gateway with no models does not touch a custom config directory", { skip: !process.env.CCR_INTERNAL_HOME_DIR }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccr-custom-dir-untouched-"));
  const customDir = path.join(root, "dotfiles", ".claude");
  const settingsFile = path.join(customDir, "settings.json");
  try {
    mkdirSync(customDir, { recursive: true });
    const original = `${JSON.stringify({
      env: {
        CLAUDE_CODE_MCP_CONFIG: "/somewhere/toolhub-mcp.json",
        USER_VALUE: "kept"
      }
    }, null, 2)}\n`;
    writeFileSync(settingsFile, original);

    const profile = {
      agent: "claude-code",
      configDir: customDir,
      enabled: true,
      id: "inkitt-claude",
      model: "Provider/model",
      name: "Inkitt Claude",
      scope: "custom",
      surface: "auto"
    };

    // No providers => no available gateway models => the cleanup path runs.
    const config = createDefaultAppConfig();
    config.Providers = [];
    config.profile.profiles = [profile];

    await applyProfileConfig(config);

    assert.equal(readFileSync(settingsFile, "utf8"), original);
    assert.deepEqual(
      readdirSync(customDir).sort(),
      ["settings.json"]
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm run test:core`
Expected: FAIL — `CLAUDE_CODE_MCP_CONFIG` is stripped from the user's file and a `settings.json.ccr-backup-<timestamp>` sibling appears, so both assertions break.

- [ ] **Step 3: Skip the cleanup for custom directories**

In `packages/core/src/profiles/service.ts`, replace `cleanupClaudeCodeToolHubArtifacts` (line 326) with:

```ts
function cleanupClaudeCodeToolHubArtifacts(profile: ProfileConfig): { changed?: boolean; message?: string; ok: boolean } {
  // A custom config directory belongs to the user, not to CCR. Skip both halves
  // of the cleanup: deleting toolhub-mcp.json without clearing the env key that
  // points at it would leave a dangling reference in the user's settings file.
  if (resolveProfileConfigDir(profile)) {
    return { changed: false, ok: true };
  }
  try {
    let changed = false;
    const mcpConfigFile = claudeCodeToolHubMcpConfigFile(profile);
    if (existsSync(mcpConfigFile)) {
      rmSync(mcpConfigFile, { force: true });
      changed = true;
    }
    changed = cleanupClaudeCodeToolHubSettingsFile(resolveClaudeCodeSettingsFile(profile), { backup: true }).changed || changed;
    return { changed, ok: true };
  } catch (error) {
    return {
      message: formatError(error),
      ok: false
    };
  }
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npm run test:core`
Expected: the new test passes. Failure count exactly 9, names unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/profiles/service.ts packages/core/test/integration/profiles/profile-service.test.mjs
git commit -m "fix: never clean ToolHub artifacts inside a custom config directory"
```

---

### Task 5: Make the custom scope reachable in the UI

**Files:**
- Modify: `packages/ui/src/pages/home/shared/types.ts:202-208`
- Modify: `packages/ui/src/pages/home/shared/options.ts:152-155`
- Modify: `packages/ui/src/pages/home/shared/profiles.ts:462-486`, `:512-533`, `:556-574`, `:624-674`, `:958-965`, `:1300-1338`
- Test: `packages/ui/test/component/profiles.test.tsx`

**Interfaces:**
- Consumes: `ProfileConfig.configDir` from Task 1.
- Produces: `AddProfileDraft.configDir: string` (always a string in the draft, `""` when unset); `profileConfigFromDraft` emits `configDir` only when non-blank and `scope === "custom"`.

- [ ] **Step 1: Write the failing test**

Append to `packages/ui/test/component/profiles.test.tsx`:

```tsx
test("custom scope survives an edit round-trip and carries configDir", () => {
  const profile = {
    agent: "claude-code" as const,
    configDir: "~/Development/inkitt/.claude",
    enabled: true,
    id: "inkitt-claude",
    model: "Provider/model",
    name: "Inkitt Claude",
    scope: "custom" as const
  };

  const draft = createProfileDraftFromProfile(profile);
  assert.equal(draft.scope, "custom");
  assert.equal(draft.configDir, "~/Development/inkitt/.claude");

  const roundTripped = profileConfigFromDraft(draft, [profile], profile);
  assert.equal(roundTripped.scope, "custom");
  assert.equal(roundTripped.configDir, "~/Development/inkitt/.claude");
});

test("configDir is dropped when the scope is not custom", () => {
  const draft = { ...createProfileDraft("claude-code"), configDir: "~/somewhere", scope: "ccr" as const };
  const config = profileConfigFromDraft(draft, []);
  assert.equal(config.configDir, undefined);
});

test("the custom scope option is offered", () => {
  assert.equal(profileScopeOptions.some((option) => option.value === "custom"), true);
});
```

Import `createProfileDraft`, `createProfileDraftFromProfile`, `profileConfigFromDraft` from `../../src/pages/home/shared/profiles` and `profileScopeOptions` from `../../src/pages/home/shared/options`, matching the import style already used in that test file.

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm run test:ui`
Expected: FAIL — `draft.scope` is `"ccr"` because `normalizeProfileFormScope` collapses it, `draft.configDir` is `undefined`, and no `custom` option exists.

- [ ] **Step 3: Add `configDir` to the draft type**

In `packages/ui/src/pages/home/shared/types.ts`, inside `AddProfileDraft`, add alphabetically (before `envRows`):

```ts
  configDir: string;
```

- [ ] **Step 4: Offer the custom scope option**

In `packages/ui/src/pages/home/shared/options.ts`, replace `profileScopeOptions`:

```ts
export const profileScopeOptions: Array<{ label: string; value: ProfileScope }> = [
  { label: "Only opened from CCR", value: "ccr" },
  { label: "System default", value: "global" },
  { label: "Custom config path", value: "custom" }
];
```

- [ ] **Step 5: Stop collapsing `custom` and carry `configDir` through**

In `packages/ui/src/pages/home/shared/profiles.ts`:

Replace `normalizeProfileFormScope` (line 962):

```ts
export function normalizeProfileFormScope(value: unknown): ProfileScope {
  return normalizeProfileScope(value);
}
```

In `createProfileDraft` (line 462), add to the returned object:

```ts
    configDir: "",
```

In both `createProfileDraftFromProfile` branches (the claude-code branch near line 512 and the codex-compatible branch near line 556), add:

```ts
      configDir: profile.configDir ?? "",
```

In `profileConfigFromDraft` (line 624), add to the object passed to `normalizeProfileItem`:

```ts
    configDir: draft.configDir,
```

In `normalizeProfileItem` (line 1300), add this line to the `claude-code` return object and to the codex-compatible return object, immediately after their `...(botGateway ? { botGateway } : {}),` entries:

```ts
      ...(scope === "custom" && profile.configDir?.trim() ? { configDir: profile.configDir.trim() } : {}),
```

This is what makes `configDir` vanish when the scope is not `custom`, which the second test asserts.

- [ ] **Step 6: Run the tests and verify they pass**

Run: `npm run test:ui`
Expected: the three new tests pass.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: clean. If `AddProfileDraft` is constructed anywhere else without `configDir`, the compiler will point at it — add `configDir: ""` there.

- [ ] **Step 8: Commit**

```bash
git add packages/ui/src/pages/home/shared/types.ts packages/ui/src/pages/home/shared/options.ts packages/ui/src/pages/home/shared/profiles.ts packages/ui/test/component/profiles.test.tsx
git commit -m "feat: make the custom profile scope selectable in the UI"
```

---

### Task 6: The configuration directory field

**Files:**
- Modify: `packages/ui/src/pages/home/components/profiles.tsx:812-824` (the `Effect scope` field), `:1279-1283` (`profileDraftValidation`)
- Modify: `packages/ui/src/pages/home/shared/profiles.ts` (new `profileConfigDirFormatError`), `:577-593` (`isProfileDraftSubmittable`)
- Modify: `packages/ui/src/pages/home/shared/i18n.tsx`
- Test: `packages/ui/test/component/profiles.test.tsx`

**Interfaces:**
- Consumes: `AddProfileDraft.configDir` from Task 5.
- Produces: `export function profileConfigDirFormatError(draft: AddProfileDraft): string | undefined` in `shared/profiles.ts` — blank/relative-path validation only, no collision check. Task 7 consumes it.

**Why no Browse button:** CCR has no config-directory picker anywhere. The provider `Configuration directory` field (`providers.tsx:1608`) is free text, and the only `dialog.showOpenDialog` in the codebase is for plugin directories (`electron/src/main/ipc.ts:176`). This field matches the provider pattern.

- [ ] **Step 1: Write the failing test**

Append to `packages/ui/test/component/profiles.test.tsx`. Add `profileConfigDirFormatError` to the existing import from `@ccr/ui/pages/home/shared/profiles.ts`:

```tsx
test("the configuration directory field appears only for custom scope", () => {
  const config = appConfigFixture();
  const customHtml = renderToStaticMarkup(
    <AddProfileForm
      botConfigs={config.botConfigs}
      draft={{ ...createProfileDraft("claude-code"), configDir: "~/Development/inkitt/.claude", scope: "custom" }}
      error=""
      onChange={() => undefined}
      onCreateBot={() => undefined}
      providers={config.Providers}
    />
  );
  assert.match(customHtml, /Configuration directory/);
  assert.match(customHtml, /~\/Development\/inkitt\/\.claude/);

  const ccrHtml = renderToStaticMarkup(
    <AddProfileForm
      botConfigs={config.botConfigs}
      draft={{ ...createProfileDraft("claude-code"), scope: "ccr" }}
      error=""
      onChange={() => undefined}
      onCreateBot={() => undefined}
      providers={config.Providers}
    />
  );
  assert.equal(/Configuration directory/.test(ccrHtml), false);
});

test("a blank or relative custom config directory is rejected", () => {
  assert.equal(Boolean(profileConfigDirFormatError({ ...createProfileDraft("claude-code"), configDir: "  ", scope: "custom" })), true);
  assert.equal(Boolean(profileConfigDirFormatError({ ...createProfileDraft("claude-code"), configDir: "relative/path", scope: "custom" })), true);
  assert.equal(profileConfigDirFormatError({ ...createProfileDraft("claude-code"), configDir: "~/Development/inkitt/.claude", scope: "custom" }), undefined);
  assert.equal(profileConfigDirFormatError({ ...createProfileDraft("claude-code"), configDir: "/abs/path", scope: "custom" }), undefined);
  // Not applicable outside custom scope.
  assert.equal(profileConfigDirFormatError({ ...createProfileDraft("claude-code"), configDir: "  ", scope: "ccr" }), undefined);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm run test:ui`
Expected: FAIL — `profileConfigDirFormatError` is not exported, and the markup contains no `Configuration directory` label.

- [ ] **Step 3: Add the format validator**

In `packages/ui/src/pages/home/shared/profiles.ts`:

```ts
export function profileConfigDirFormatError(draft: AddProfileDraft): string | undefined {
  if (draft.scope !== "custom" || (draft.agent !== "claude-code" && draft.agent !== "codex")) {
    return undefined;
  }
  const value = draft.configDir.trim();
  if (!value) {
    return "Configuration directory is required for a custom config path.";
  }
  if (value !== "~" && !value.startsWith("~/") && !value.startsWith("/")) {
    return "Configuration directory must be an absolute path or start with ~/.";
  }
  return undefined;
}
```

Wire it into `isProfileDraftSubmittable` (line 577) by adding, before its final `return true`:

```ts
  if (profileConfigDirFormatError(draft)) {
    return false;
  }
```

- [ ] **Step 4: Surface it in the form validation**

In `packages/ui/src/pages/home/components/profiles.tsx`, extend the `profileDraftValidation` key union (line 1283) — it is written out twice, in the return type and in the `issues` declaration. Add `"configDir"` to both:

```ts
): Partial<Record<"allowedModels" | "bot" | "configDir" | "defaultModel" | "env" | "handoff" | "kimiModel" | "models" | "name", string>> {
  const issues: Partial<Record<"allowedModels" | "bot" | "configDir" | "defaultModel" | "env" | "handoff" | "kimiModel" | "models" | "name", string>> = {};
```

and inside the function body add:

```ts
  const configDirIssue = profileConfigDirFormatError(draft);
  if (configDirIssue) {
    issues.configDir = configDirIssue;
  }
```

Import `profileConfigDirFormatError` from `../shared/profiles` alongside the other shared imports in this file.

- [ ] **Step 5: Render the field**

In `packages/ui/src/pages/home/components/profiles.tsx`, immediately after the `Effect scope` `<Field>` block (which ends at line 824), add:

```tsx
        {draft.scope === "custom" && (draft.agent === "claude-code" || draft.agent === "codex") ? (
          <Field label={t("Configuration directory")} requirement="required" requirementLabel={requiredFieldLabel}>
            <Input
              aria-label={t("Configuration directory")}
              onChange={(event) => onChange({ configDir: event.target.value })}
              placeholder={draft.agent === "codex" ? "~/.codex" : "~/.claude"}
              value={draft.configDir}
            />
            {validation.configDir ? <ProfileFieldHint>{t(validation.configDir)}</ProfileFieldHint> : null}
          </Field>
        ) : null}
```

Restrict the scope selector to agents that support `custom`. Replace the `options` expression inside the `Effect scope` `SelectControl` (line 815) with:

```tsx
            options={translateOptions(
              draft.agent === "grok" || draft.agent === "kimi" || draft.agent === "pi"
                || draft.agent === "claude-design"
                ? profileScopeOptions.filter((option) => option.value === "ccr")
                : draft.agent === "claude-code" || draft.agent === "codex"
                    ? profileScopeOptions
                    : profileScopeOptions.filter((option) => option.value !== "custom"),
              t
            )}
```

- [ ] **Step 6: Add the i18n strings**

`"Configuration directory"` already exists in both locales (`i18n.tsx:315` EN, `:1100` ZH). Add to the English map:

```ts
      "Custom config path": "Custom config path",
      "Configuration directory is required for a custom config path.": "Configuration directory is required for a custom config path.",
      "Configuration directory must be an absolute path or start with ~/.": "Configuration directory must be an absolute path or start with ~/.",
```

and to the Chinese map:

```ts
      "Custom config path": "自定义配置路径",
      "Configuration directory is required for a custom config path.": "自定义配置路径需要填写配置目录。",
      "Configuration directory must be an absolute path or start with ~/.": "配置目录必须是绝对路径或以 ~/ 开头。",
```

- [ ] **Step 7: Run the tests and verify they pass**

Run: `npm run test:ui`
Expected: both new tests pass.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add packages/ui/src/pages/home/components/profiles.tsx packages/ui/src/pages/home/shared/profiles.ts packages/ui/src/pages/home/shared/i18n.tsx packages/ui/test/component/profiles.test.tsx
git commit -m "feat: add the profile configuration directory field"
```

---

### Task 7: Block colliding configuration directories

**Files:**
- Modify: `packages/ui/src/pages/home/shared/profiles.ts` (new `profileConfigDirCollision`)
- Modify: `packages/ui/src/pages/home/App.tsx:733-734`
- Test: `packages/ui/test/component/profiles.test.tsx`

**Interfaces:**
- Consumes: `AddProfileDraft.configDir` from Task 5; `normalizeLocalAgentConfigDirForComparison` from `packages/ui/src/pages/home/shared/providers.ts:85`.
- Produces: `export function profileConfigDirCollision(draft: AddProfileDraft, existingProfiles: ProfileConfig[], editingProfileId?: string): ProfileConfig | undefined` — the conflicting profile, or `undefined`.

**Why a separate function from Task 6's:** `profileDraftValidation` and `isProfileDraftSubmittable` receive only the draft; neither has the profile list. `App.tsx:733` does (`draftConfig.profile.profiles`), and already composes guards there in exactly this shape — `isProfileBotSelectionValid(profileDraft, draftConfig.botConfigs)`. Changing the two existing signatures to thread a profile list through would touch far more call sites than the feature needs.

- [ ] **Step 1: Write the failing test**

Append to `packages/ui/test/component/profiles.test.tsx`, adding `profileConfigDirCollision` to the shared-profiles import:

```tsx
test("a custom config directory colliding with another enabled profile is detected", () => {
  const existing: ProfileConfig = {
    agent: "claude-code",
    configDir: "~/Development/inkitt/.claude",
    enabled: true,
    id: "inkitt-claude",
    model: "Provider/model",
    name: "Inkitt Claude",
    scope: "custom"
  };

  // The same directory spelled differently still collides.
  const collision = profileConfigDirCollision(
    { ...createProfileDraft("claude-code"), configDir: "~/Development/inkitt/foo/../.claude", scope: "custom" },
    [existing]
  );
  assert.equal(collision?.id, "inkitt-claude");

  // A disabled neighbour does not collide.
  assert.equal(
    profileConfigDirCollision(
      { ...createProfileDraft("claude-code"), configDir: "~/Development/inkitt/.claude", scope: "custom" },
      [{ ...existing, enabled: false }]
    ),
    undefined
  );

  // Editing the profile itself is not a collision with itself.
  assert.equal(
    profileConfigDirCollision(
      { ...createProfileDraft("claude-code"), configDir: "~/Development/inkitt/.claude", scope: "custom" },
      [existing],
      "inkitt-claude"
    ),
    undefined
  );

  // A different directory is fine.
  assert.equal(
    profileConfigDirCollision(
      { ...createProfileDraft("claude-code"), configDir: "~/Development/other/.claude", scope: "custom" },
      [existing]
    ),
    undefined
  );
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm run test:ui`
Expected: FAIL — `profileConfigDirCollision` is not exported.

- [ ] **Step 3: Implement the collision check**

In `packages/ui/src/pages/home/shared/profiles.ts`, importing `normalizeLocalAgentConfigDirForComparison` from `./providers`:

```ts
// Two profiles writing to one directory would fight over the same settings file.
// Paths are compared normalized, so "a/foo/../b" and "a/b" collide.
export function profileConfigDirCollision(
  draft: AddProfileDraft,
  existingProfiles: ProfileConfig[],
  editingProfileId?: string
): ProfileConfig | undefined {
  if (draft.scope !== "custom" || (draft.agent !== "claude-code" && draft.agent !== "codex")) {
    return undefined;
  }
  const value = draft.configDir.trim();
  if (!value) {
    return undefined;
  }
  const target = normalizeLocalAgentConfigDirForComparison(value);
  return existingProfiles.find((profile) => {
    if (!profile.enabled || profile.id === editingProfileId || profile.scope !== "custom") {
      return false;
    }
    const other = profile.configDir?.trim();
    return Boolean(other) && normalizeLocalAgentConfigDirForComparison(other) === target;
  });
}
```

- [ ] **Step 4: Block submission**

In `packages/ui/src/pages/home/App.tsx`, add `profileConfigDirCollision` to the shared-profiles import, then extend both guards at lines 733-734:

```ts
  const canSubmitProfile = profileRouteTargetReady && isProfileDraftSubmittable(profileDraft) && isProfileBotSelectionValid(profileDraft, draftConfig.botConfigs)
    && !profileConfigDirCollision(profileDraft, draftConfig.profile.profiles);
  const canSubmitProfileEdit = profileRouteTargetReady && profileEditIndex !== undefined && isProfileDraftSubmittable(profileEditDraft) && isProfileBotSelectionValid(profileEditDraft, draftConfig.botConfigs)
    && !profileConfigDirCollision(profileEditDraft, draftConfig.profile.profiles, draftConfig.profile.profiles[profileEditIndex]?.id);
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npm run test:ui`
Expected: the new test passes.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: core failure count exactly 9 with the names listed in Global Constraints; UI, electron, cli and architecture suites green; types clean.

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/pages/home/shared/profiles.ts packages/ui/src/pages/home/App.tsx packages/ui/test/component/profiles.test.tsx
git commit -m "feat: block profiles sharing a custom config directory"
```

---

### Task 8: Redirect backups out of the user's directory

**This task is independently droppable.** Everything before it delivers the working feature. If the refactor proves more invasive than it looks, stop, and instead document adding `*.ccr-backup-*` and `*.ccr-original` to the dotfiles repo's `.gitignore`. Do not half-apply it: relocating writes without relocating reads silently breaks the restore safety net.

**Files:**
- Modify: `packages/core/src/profiles/service.ts:2842-2862` (`writeFileWithBackup`), `:3494` (`originalSnapshotCandidate`), `:3505-3524` (`backupCurrentConfigFile`, `backupFiles`), `:3526-3539` (`ensureOriginalSnapshot`), `:3552-3563` (the three path helpers), `:3443-3480` (`restoreGlobalConfigFile`)
- Test: `packages/core/test/integration/profiles/profile-service.test.mjs`

**Interfaces:**
- Consumes: `resolveProfileConfigDir` from Task 2.
- Produces: no new exports. Backups for custom-directory profiles live under `<CONFIGDIR>/profiles/<slug>/backups/`.

**Why:** `backupFilePath` (`service.ts:3552`) returns `${file}.ccr-backup-<timestamp>` and `ensureOriginalSnapshot` (`:3526`) writes `${file}.ccr-original`, both siblings of the target. Nothing prunes them on this path — `backupFiles()` (`:3513`) only enumerates them for restore and `cleanupGeneratedBinBackups` prunes `CONFIGDIR/bin` only. A git-tracked dotfiles directory would accumulate them indefinitely.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/integration/profiles/profile-service.test.mjs`:

```javascript
test("custom config directory backups are written outside that directory", { skip: !process.env.CCR_INTERNAL_HOME_DIR }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccr-custom-dir-backups-"));
  const customDir = path.join(root, "dotfiles", ".claude");
  const settingsFile = path.join(customDir, "settings.json");
  try {
    mkdirSync(customDir, { recursive: true });
    writeFileSync(settingsFile, `${JSON.stringify({ env: { USER_VALUE: "kept" } }, null, 2)}\n`);

    const profile = {
      agent: "claude-code",
      configDir: customDir,
      enabled: true,
      id: "inkitt-claude",
      model: "Provider/model",
      name: "Inkitt Claude",
      scope: "custom",
      surface: "auto"
    };

    const config = createDefaultAppConfig();
    config.APIKEY = "ccr-custom-backup-test";
    config.APIKEYS = [{
      createdAt: "2026-01-01T00:00:00.000Z",
      id: `profile:${profile.id}`,
      key: "ccr-custom-backup-test",
      name: "Profile: Claude Code"
    }];
    config.Providers = [{
      api_base_url: "https://example.test/v1",
      api_key: "provider-key",
      models: ["model"],
      name: "Provider"
    }];
    config.profile.profiles = [profile];

    await applyProfileConfig(config);
    // A second apply with a different model forces a changed write, hence a backup.
    config.profile.profiles = [{ ...profile, model: "Provider/other" }];
    config.Providers[0].models = ["model", "other"];
    await applyProfileConfig(config);

    const strayBackups = readdirSync(customDir)
      .filter((entry) => entry.includes(".ccr-backup-") || entry.endsWith(".ccr-original"));
    assert.deepEqual(strayBackups, []);

    const backupDir = path.join(CONFIGDIR, "profiles", "inkitt-claude", "backups");
    assert.equal(existsSync(backupDir), true);
    assert.equal(readdirSync(backupDir).some((entry) => entry.includes("settings.json")), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm run test:core`
Expected: FAIL — `strayBackups` contains `settings.json.ccr-original` and a `settings.json.ccr-backup-<timestamp>` entry, and the CCR-side backup directory does not exist.

- [ ] **Step 3: Thread an optional backup directory through the helpers**

All six path/IO helpers must take the same optional directory, defaulting to `path.dirname(file)` so every existing caller keeps today's behaviour:

```ts
function backupBaseDir(file: string, backupDir: string | undefined): string {
  return backupDir ?? path.dirname(file);
}

function backupFilePath(file: string, backupDir?: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(backupBaseDir(file, backupDir), `${path.basename(file)}.ccr-backup-${timestamp}`);
}

function originalBackupFilePath(file: string, backupDir?: string): string {
  return path.join(backupBaseDir(file, backupDir), `${path.basename(file)}${originalBackupSuffix}`);
}

function originalMissingFilePath(file: string, backupDir?: string): string {
  return path.join(backupBaseDir(file, backupDir), `${path.basename(file)}${originalMissingSuffix}`);
}

function backupFiles(file: string, backupDir?: string): string[] {
  const dir = backupBaseDir(file, backupDir);
  const prefix = `${path.basename(file)}.ccr-backup-`;
  try {
    return readdirSync(dir)
      .filter((entry) => entry.startsWith(prefix))
      .sort()
      .map((entry) => path.join(dir, entry));
  } catch {
    return [];
  }
}
```

`ensureOriginalSnapshot`, `writeFileWithBackup`, `backupCurrentConfigFile`, `originalSnapshotCandidate` and `restoreGlobalConfigFile` each gain the same optional `backupDir` parameter and pass it down. `ensureOriginalSnapshot` must `mkdirSync(backupBaseDir(file, backupDir), { recursive: true })` before copying, because the CCR-side directory may not exist yet.

- [ ] **Step 4: Pass the custom backup directory at the claude-code and codex apply sites**

Compute it once per profile where the settings/config file is resolved, and pass it to every `writeFileWithBackup` call for that profile:

```ts
function profileBackupDir(profile: ProfileConfig): string | undefined {
  return resolveProfileConfigDir(profile)
    ? path.join(ccrManagedProfileDir(profile), "backups")
    : undefined;
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npm run test:core`
Expected: the new test passes. Crucially, the pre-existing restore tests must still pass — they exercise the read side, and if the read and write sides disagree the safety net is broken. Failure count exactly 9, names unchanged.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/profiles/service.ts packages/core/test/integration/profiles/profile-service.test.mjs
git commit -m "feat: keep custom config directory backups in the CCR tree"
```

---

## Final verification

- [ ] Run `npm test` — core failure count is exactly 9 with the names listed in Global Constraints; UI, electron, cli and architecture suites green.
- [ ] Run `npm run typecheck` — clean.
- [ ] Manually confirm the round trip: create a claude-code profile with scope `Custom config path` and a directory containing a `settings.json` that has your own keys; apply; verify your keys survived, `ANTHROPIC_BASE_URL` was added, and (after Task 8) no `.ccr-backup-*` or `.ccr-original` file appeared in that directory.

## Known gaps carried from the spec

These are deliberate, recorded so a reviewer does not file them as defects:

- Disabling a custom-directory profile leaves CCR's keys in the user's `settings.json`, including an `ANTHROPIC_BASE_URL` pointing at a possibly stopped gateway. Cleanup is manual.
- A mistyped directory is created silently and accumulates CCR keys that are never cleaned up. This is the interaction of the auto-create and no-cleanup decisions.
- Switching an existing profile to a custom directory orphans its old `profiles/<slug>/` directory; nothing is migrated.
- The `sanitizeProfilePathSegment` / `sanitizePathSegment` case divergence is untouched.
- A codex custom directory always receives two CCR-generated files (`ccr-model-catalog.json`, `<providerId>.config.toml`); they cannot be relocated because Codex loads them from `CODEX_HOME`.
- Unverified premise: nobody has checked what Claude Code does when `CLAUDE_CODE_MCP_CONFIG` points at a missing file. Task 4's design avoids creating that state, so the answer does not block the plan, but it was the reason for preferring the skip-both approach.
