# Per-profile configuration directory

**Status:** design approved, implementation not started
**Date:** 2026-08-31
**Branch:** `feat/profile-config-dir`

## Problem

A CCR profile's agent configuration lives in one of two places, and neither can be
chosen by the user:

- `scope: "ccr"` writes to `~/.claude-code-router/profiles/<slug>/claude/`
- `scope: "global"` writes to `~/.claude`

There is no way to point a profile at an arbitrary directory such as
`~/Development/inkitt/.claude`, which is where a dotfiles repo (`dotfiles-inkitt`)
keeps its Claude Code configuration.

Working `scope: "global"` around the problem fails: `settingsFile` does accept an
arbitrary path, but `enforceSingleEnabledGlobalProfilePerAgent`
(`contracts/app.ts:1560`) permits only one enabled global profile per agent, and
that single profile is load-bearing for legacy config synchronisation
(`config/config.ts:437-452`). Several directory-scoped profiles cannot coexist.

## Approach

Finish the half-built `custom` scope. `ProfileScope` already includes `"custom"`
(`contracts/app.ts:1482`), the config parser already accepts it
(`config/config.ts:3949`), and a label already exists for it — `"Custom config
path"` (`ui/.../shared/profiles.ts:1622`). It is unreachable only because the
profile form collapses `custom` to `ccr` (`ui/.../shared/profiles.ts:964`) and the
scope option list omits it (`ui/.../shared/options.ts:152`).

`custom` is a *generated* scope, so it is exempt from the single-global-profile
rule and several custom-directory profiles may be enabled at once.

### Rejected alternatives

**Expose `settingsFile`/`codexHome` in the UI for `global` scope.** Smaller diff —
both fields already exist and work — but requires relaxing the one-enabled-global-
profile-per-agent invariant that six call sites depend on, including legacy config
sync. Larger blast radius than the feature warrants.

**Symlink the CCR profile directory at the dotfiles directory.** Zero code, but
CCR's cleanup `rmSync`s files it enumerates under `profiles/`, so it would delete
through the symlink into the dotfiles repo. Actively unsafe.

## Contract

One new optional field on `ProfileConfig` (`contracts/app.ts:1513`):

```ts
configDir?: string;   // agent config dir chosen by the user; honoured only when scope === "custom"
```

Semantics, for `scope: "custom"` only:

| `configDir` | claude-code | codex |
|---|---|---|
| set | `CLAUDE_CONFIG_DIR = <configDir>`, writes `<configDir>/settings.json` | `CODEX_HOME = <configDir>`, writes `<configDir>/config.toml` |
| empty | unchanged: `<CONFIGDIR>/profiles/<slug>/custom/claude/settings.json` | unchanged: `<CONFIGDIR>/profiles/<slug>/custom/codex/config.toml` |

The directory named by the user **is** the agent config directory. Nothing is
appended — no `<slug>`, no `/claude`, no `/custom`. This is required by the merge
requirement: a nested directory would be freshly created and have no existing
`settings.json` to merge with.

Only `claude-code` and `codex` read `configDir`. The other agents ignore it and the
UI does not offer it to them.

`CLAUDE_CONFIG_DIR` needs no change: it is already derived as
`path.dirname(settingsFile)` (`launch-core.ts:326`, `launch-service.ts:1348`).

### Back-compat

The empty-`configDir` branch reproduces today's behaviour exactly, so
`profile-launch-core.test.mjs:252` passes unmodified and existing `custom`-scope
profiles are unaffected. No migration is required.

## Merge and backup behaviour (already correct — do not rebuild)

Both requirements the user asked for are satisfied by existing code. The spec's job
is to route the custom scope through it and pin it with tests.

**claude-code.** `applyClaudeCodeProfile` reads the existing settings object
(`service.ts:402`), computes `nextSettings` touching only managed keys, and
`writeClaudeCodeSettingsIfManagedChanged` (`service.ts:2753`) writes only when those
managed keys changed. Unmanaged keys, `statusLine`, `agents/`, `commands/`, `hooks/`
are untouched.

**codex.** `buildCodexConfigToml` (`service.ts:1024`) takes the existing file as
`source` and strips/replaces only CCR marker-delimited blocks. User TOML survives.

**Backups.** `writeFileWithBackup` (`service.ts:2842`) writes a timestamped backup
and, once, an `ensureOriginalSnapshot` pristine pre-CCR copy.

## Resolvers

The `configDir` branch is added to four functions — deliberately duplicated:

- `service.ts:884` `resolveClaudeCodeSettingsFile`
- `service.ts:996` `resolveCodexConfigFile`
- `launch-core.ts:263` `resolveClaudeCodeSettingsFile`
- `launch-core.ts:270` `resolveCodexConfigFile`

**Do not unify these two implementations.** They differ in a way that is not safe to
collapse: `service.ts:3721` `sanitizeProfilePathSegment` preserves case, while
`launch-core.ts:425` `sanitizePathSegment` lowercases. Profile ids created through
the UI are already lowercase (`uniqueProfileId`, `ui/.../shared/profiles.ts:1573`),
but the config parser preserves an imported or hand-edited id's case
(`config/config.ts:3613` uses `readString`, which only trims). On a case-sensitive
filesystem the two layers would therefore resolve different directories. Delegating
one to the other would silently change the apply-side slug and orphan existing
profile directories. This divergence is pre-existing and out of scope; it is
recorded here so the duplication is not "cleaned up" later by mistake.

When `configDir` is set the slug is never computed, so the divergence cannot affect
the new path.

`ccrManagedProfileDir` is not modified.

## Ownership of the user's directory

The directory belongs to the user's dotfiles repo, not to CCR. The governing rule:

> **CCR touches the configured directory only during a normal apply, and writes only
> the files listed below.**

### What actually lands in the directory

This is the full inventory, and it is more than the agent config file. Anyone
pointing a dotfiles repo at CCR needs it to write a `.gitignore`.

claude-code:

| File | Kind |
|---|---|
| `settings.json` | agent-owned, merged — only managed keys touched (`service.ts:2753`) |
| `.claude.json` | agent-owned, merged — CCR adds `autoCompactWindowsCache`, preserving the rest (`service.ts:2252`). This is Claude Code's own global state file. |
| `cache/gateway-models.json` | deleted, never written — model-discovery invalidation (`service.ts:472`) |

codex:

| File | Kind |
|---|---|
| `config.toml` | agent-owned, merged — only CCR marker blocks replaced (`service.ts:1024`) |
| `ccr-model-catalog.json` | CCR-generated (`service.ts:1010`) |
| `<providerId>.config.toml` | CCR-generated (`service.ts:1145`) — always written, because `normalizeCodexConfigFormat` returns `separate_profile_files` unconditionally (`service.ts:3725`) |

The two CCR-generated codex files cannot be relocated: Codex loads the separate
profile file from `CODEX_HOME`, and the catalog is referenced from `config.toml`.
A codex custom directory will therefore always contain CCR-generated files.

Recommended `.gitignore` for a dotfiles repo pointed at by a codex profile:

```gitignore
ccr-model-catalog.json
*.config.toml
```

Three consequences follow from the governing rule.

### Disable and delete do not write

When a custom-directory profile is disabled or deleted, CCR leaves its injected keys
in place and surfaces a UI warning naming the file, rather than editing the user's
tracked `settings.json`. `restoreDisabledGlobalProfile`'s `isGlobalProfile` gate
(`service.ts:3030`) therefore stays as it is.

Accepted cost: a disabled profile leaves `ANTHROPIC_BASE_URL` pointing at a gateway
that may not be running. Re-enabling the profile, or editing the file by hand,
clears it.

### ToolHub cleanup is skipped for custom directories

`cleanupClaudeCodeToolHubArtifacts` (`service.ts:326`) `rmSync`s the profile's
`toolhub-mcp.json` **and** writes to the resolved settings file to delete two env
keys (`service.ts:334`). It fires when the gateway has no available models at all
(`service.ts:166`), across all profiles regardless of enabled state.

For custom-directory profiles this cleanup is skipped entirely — neither the
`rmSync` nor the settings write. Skipping only the write would delete
`toolhub-mcp.json` while leaving `settings.json` pointing at it, committing a
dangling reference to the dotfiles repo. Skipping both keeps the pointer and the
file consistent; the stale config sits in CCR's own untracked tree and is
regenerated on the next apply.

The other cleanup path (`service.ts:252`) works off a directory scan of
`CONFIGDIR/profiles` and structurally cannot reach a custom directory. No change
needed, and `managedClaudeCodeGeneratedFiles` (`service.ts:270`) is deliberately
**not** extended to find custom directories.

### Backups are redirected out of the directory

`backupFilePath` (`service.ts:3552`) returns `${file}.ccr-backup-<timestamp>` and
`ensureOriginalSnapshot` (`service.ts:3526`) writes `${file}.ccr-original` — both
siblings of the target file. Nothing prunes them on this path: `backupFiles()`
(`service.ts:3513`) only enumerates them for restore, and `cleanupGeneratedBinBackups`
prunes `CONFIGDIR/bin` only. (OpenCode and Kilo do prune their own —
`opencode/profile-config.ts:279`, `kilo/profile-config.ts:193`.) Left alone, a
dotfiles directory would accumulate untracked backup files indefinitely.

For custom-directory profiles, backups and the original snapshot are written to
`CONFIGDIR/profiles/<slug>/backups/` instead. `writeFileWithBackup`,
`ensureOriginalSnapshot`, `backupFilePath`, `originalBackupFilePath`,
`originalMissingFilePath` and `backupFiles` must all take the same backup directory,
since restore reads backups from `path.dirname(file)` today and would otherwise stop
finding them.

## Collisions

Two profiles writing to the same directory would fight over one `settings.json`,
exactly as two enabled global profiles would. Saving a profile is blocked when its
directory collides with another **enabled** profile's target directory, comparing:

- other custom-scope profiles' `configDir`
- global-scope profiles' resolved settings directory / `codexHome`

Comparison reuses `normalizeLocalAgentConfigDirForComparison`
(`ui/.../shared/providers.ts:85`), which already handles NFC, `.`/`..`, Windows
drive letters and UNC paths.

The error names the conflicting profile and the directory.

## Directory creation

The directory is created if missing (`mkdirSync` recursive, which
`writeFileWithBackup` already does). Validation is limited to: non-empty after trim,
`~` and `~/` expansion, and absolute after expansion.

Known cost, accepted deliberately: a typo (`~/Development/inkitt/.clade`) creates an
empty directory and the profile appears to work while writing to the wrong place.
This compounds with the no-cleanup-on-disable rule — a typo directory accumulates
CCR keys and is never cleaned up automatically.

Tilde expansion at resolve time uses `resolveUserPath`, consistent with
`settingsFile` and `codexHome`.

## UI

- `profileScopeOptions` (`shared/options.ts:152`) gains
  `{ label: "Custom config path", value: "custom" }`, offered only for `claude-code`
  and `codex`. The existing agent filter at `profiles.tsx:816` already restricts the
  other agents.
- `normalizeProfileFormScope` (`shared/profiles.ts:964`) stops collapsing `custom`
  to `ccr`. This is what currently makes an edited custom profile silently downgrade.
- A `Configuration directory` field, shown only when `scope === "custom"`, with
  placeholder `~/.claude` or `~/.codex`, plus `configDir` on `AddProfileDraft`
  (`shared/types.ts:202`).
- A warning on a disabled custom-directory profile naming the file that still holds
  CCR's keys.

There is no directory picker. CCR has no config-directory picker anywhere — the
provider `Configuration directory` field (`providers.tsx:1608`) is free text plus a
Scan button, and the only `dialog.showOpenDialog` in the codebase is for plugin
directories (`electron/src/main/ipc.ts:176`). This field matches the provider
pattern: free text, validated on save.

i18n keys `"Configuration directory"` (EN `i18n.tsx:315`, ZH `:1100` — `配置目录`)
and `"Custom config path"` already exist. New keys are needed for the collision
error and the disabled-profile warning, in both EN and ZH.

## Tests

Regression locks:

- `profile-launch-core.test.mjs:252` extended — `configDir` set resolves to the exact
  directory for both agents; `configDir` empty resolves to today's paths unchanged.
- The `service.ts` and `launch-core.ts` resolvers agree for the same profile, so the
  deliberate duplication cannot drift silently.

Behaviour:

- Applying a claude-code custom-directory profile into a `settings.json` that already
  has unmanaged keys preserves every one of them.
- Applying a codex custom-directory profile into a `config.toml` with pre-existing
  user tables preserves those tables.
- Disabling a custom-directory profile writes nothing to the configured directory.
- The no-available-models path writes nothing to the configured directory and does
  not delete `toolhub-mcp.json`.
- Backups and the original snapshot are created under `CONFIGDIR/profiles/<slug>/backups/`
  and no `.ccr-backup-*` or `.ccr-original` file appears in the configured
  directory.
- Restore still finds backups after they are relocated.

UI:

- `custom` is offered for claude-code and codex, and not for the other agents.
- The `configDir` field appears only for `custom` scope.
- An edited custom profile no longer downgrades to `ccr`.
- Saving is blocked when the directory collides with another enabled profile.

## Out of scope

- The `sanitizeProfilePathSegment` / `sanitizePathSegment` case divergence.
- Agents other than `claude-code` and `codex`.
- Pruning of existing accumulated `.ccr-backup-*` files.
- Migrating content from an existing `profiles/<slug>/` directory when a profile is
  switched to a custom directory. The old directory is left in place and the new
  configuration is generated fresh, merging into whatever already exists at the
  destination. Switching back restores the previous behaviour.
