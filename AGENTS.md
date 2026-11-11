# Repository Guidelines

## Project Structure & Module Organization

Shield Minimal is a Chrome MV3 extension with **no build step and no npm dependencies** — the working tree *is* the artifact, loaded via `chrome://extensions` → *Load unpacked*.

- `manifest.json` — MV3 manifest: DNR permissions, service worker, popup, two content scripts (`MAIN` and `ISOLATED` worlds).
- `background/service_worker.js` — owns `chrome.storage.local` state (`ruleConfig`, `siteConfigs`, `stats`), turns URL patterns into `declarativeNetRequest` dynamic rules, answers popup messages.
- `popup/popup.html` / `.css` / `.js` — toolbar panel: per-site toggle, blocked counters, JSON import/export, remote sync.
- `scripts/main_world_hook.js` — `document_start` in the `MAIN` world: stubs ad globals, patches `window.open`, defuses click-hijack overlays.
- `scripts/content_isolated.js` — `ISOLATED` world cosmetic filtering; injects a `display:none` stylesheet for ad containers.
- `icons/` — 16/48/128 px PNGs referenced by the manifest.

## Build, Test, and Development Commands

There is no build or package manager.

- `jq . manifest.json` — validate the manifest after editing.
- `python3 -m http.server 8080` — optional; preview the popup outside Chrome.
- `git diff --stat` — review changes. Only `README.md` is tracked, so `git add -A` before your first commit.

Hit **Reload** on the extension card after each edit — the service worker and content scripts are cached aggressively.

## Coding Style & Naming Conventions

Plain ES2020, no framework, no bundler. Match the existing style:

- 2-space indent, single quotes, semicolons.
- Every file wraps its logic in an IIFE with `'use strict'`.
- JS uses `camelCase`; CSS classes are `kebab-case`; colors live as custom properties in `:root`.
- Comments and user-facing strings are Chinese. DNR rule ids start at `RULE_ID_BASE = 2000`.
- Keep logic data-driven: extend `DEFAULT_CONFIG` in the service worker instead of hard-coding selectors in content scripts.

## Testing Guidelines

No automated suite exists; verification is manual in Chrome:

1. Load unpacked and open the popup — the active hostname and rule count must render.
2. Import a JSON config → popup reports success, counters update, page reloads.
3. Visit a site with a known ad container → the element is hidden and the block count rises.
4. Toggle the site switch → the host is whitelisted and ads reappear.

## Commit & Pull Request Guidelines

History is a single `Initial commit`, so adopt Conventional Commits (`feat(popup): add rule preview`, `fix(hooks): guard undefined window.open`). Keep the subject imperative and under 72 characters; add a body only when the change affects the rule format or storage keys.

PRs should state the user-visible effect, list manual verification steps, and include screenshots for popup changes. Bump `version` in `manifest.json` and `DEFAULT_CONFIG.version` together, and flag any change to the config JSON schema — external consumers rely on it.

## Known Gaps

`SYNC_REMOTE_RULES` is sent by the popup but unhandled in the background; `stats` and `globalEnabled` are read but never written; `GET_SELECTORS_FOR_DOMAIN` is never called. Resolve these before building on them.
