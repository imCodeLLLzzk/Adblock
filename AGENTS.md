# Repository Guidelines

## Project Structure & Module Organization

Shield Minimal is a Chrome MV3 extension with **no build step and no npm dependencies** — the working tree *is* the artifact, loaded via `chrome://extensions` → *Load unpacked*.

- `manifest.json` — MV3 manifest: DNR permissions, service worker, popup, two content scripts (`MAIN` and `ISOLATED` worlds).
- `background/service_worker.js` — owns `chrome.storage.local` state (`ruleConfig`, `siteConfigs`, `globalEnabled`), turns URL patterns into `declarativeNetRequest` dynamic rules, registers content scripts dynamically with per-domain `excludeMatches`, and answers popup messages.
- `popup/popup.html` / `.css` / `.js` — toolbar panel: global toggle, per-site toggle, blocked counters, JSON import/export, remote sync.
- `scripts/main_world_hook.js` — `document_start` in the `MAIN` world: stubs ad globals and wraps `window.open` in a `Proxy` so it still reports `[native code]`. Registered dynamically by the background, so it cannot read `chrome.storage`.
- `scripts/content_isolated.js` — `ISOLATED` world: cosmetic filtering via a constructed `CSSStyleSheet`, plus removal of anti-adblock overlays and transparent click-hijack layers.
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

## How the Domain Switch Works

DNR `urlFilter` matches the **request target**, while a whitelist domain is the **initiating page** — they are different domains, so an `allow` rule can never match. Instead, whitelisted domains are excluded on the block rule itself:

- `excludedInitiatorDomains` — request initiator (Chrome 101+).
- `excludedTopDomains` — top-level frame domain (newer Chrome only). Write it only after `supportsExcludedTopDomains()` probe succeeds; unknown condition fields make Chrome reject the **whole** rule batch.

Both fields inherit subdomains automatically. The content-script side must therefore use `*://<domain>/*` **and** `*://*.<domain>/*` — `*.example.com` does not match the bare domain.

Domain strings must pass through `normalizeDomain()` before reaching DNR: one malformed entry (protocol, port, wildcard, uppercase) rejects the entire batch and silently disables all blocking.

## Testing Guidelines

No automated suite exists; verification is manual in Chrome:

1. Load unpacked and open the popup — the active hostname and rule count must render.
2. Import a JSON config → popup reports success, counters update, page reloads.
3. Visit a site with a known ad container → the element is hidden and the block count rises.
4. Toggle the site switch → the host is whitelisted and ads reappear; verify via `chrome.declarativeNetRequest.getDynamicRules()` that the block rule now carries `excludedInitiatorDomains`.
5. Toggle the global switch → no dynamic rules remain and both content scripts are excluded from every URL.

## Commit & Pull Request Guidelines

History is a single `Initial commit`, so adopt Conventional Commits (`feat(popup): add rule preview`, `fix(hooks): guard undefined window.open`). Keep the subject imperative and under 72 characters; add a body only when the change affects the rule format or storage keys.

PRs should state the user-visible effect, list manual verification steps, and include screenshots for popup changes. Bump `version` in `manifest.json` and `DEFAULT_CONFIG.version` together, and flag any change to the config JSON schema — external consumers rely on it.

## Overlay Removal Channels

`scripts/content_isolated.js` defeats hostile overlays through three independent channels, so it generalizes beyond any single site:

1. **Signature match** — text nodes are scanned with a `TreeWalker` (never `element.textContent` per element, which is O(n²)); hits come from `DEFAULT_SIGNATURES` plus `ruleConfig.antiOverlay.signatures`.
2. **Structural match** — a full-viewport dark scrim containing a centered box with no form controls. Boxes with `input`/`textarea`/`select`/`form`/`iframe` are treated as legitimate (login) modals and left alone. Disable via `antiOverlay.structural: false`.
3. **Click-hijack layer** — full-viewport, high `z-index`, fully transparent.

Removal must delete the whole overlay root, not just the message node, otherwise the backdrop stays. To find it, walk up from the matched node and keep the outermost element that is positioned with a high `z-index` or is a viewport-covering dark scrim.

## Anti-Detection Notes

Sites detect extensions by calling `Function.prototype.toString()` on patched APIs. Wrap patched functions in a `Proxy` over a native function and return the native source string from a `get` trap — `Function.prototype.toString.call(proxy)` then reports `function () { [native code] }`. Do **not** patch `EventTarget.prototype.addEventListener`; it is the easiest signature to detect and the easiest to break pages with. Keep DOM footprint minimal: construct stylesheets instead of appending `<style>` elements, and remove hostile overlays via `MutationObserver` instead of injecting helpers.

## Known Gaps

`stats` is read by the popup but never written, so the blocked counter stays at zero; `GET_SELECTORS_FOR_DOMAIN` is served by the background but the content script reads `ruleConfig` directly instead. Resolve these before building on them.
