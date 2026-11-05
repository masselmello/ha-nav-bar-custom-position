# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A HACS frontend plugin ("Navbar Position", HACS category `plugin`) for Home Assistant that moves the Lovelace dashboard navigation bar (the header) to the bottom of the screen. Supports HA versions newer than 2023.04.

The whole plugin is a single file, `ha-navbar-position.js`: plain browser JavaScript loaded as a Lovelace dashboard resource. It must work loaded **both as a module and as a classic script**, with no build step and no dependencies.

## Repository and remotes

- `origin` is the fork `masselmello/ha-nav-bar-custom-position`. Upstream is `javawizard/ha-navbar-position`.
- The script runs inside the logged-in HA page, where it could read auth tokens. Review upstream diffs before merging them.

## Commands

There is no build, lint or test suite.

- Syntax check: `node --check ha-navbar-position.js`. For module mode, run the same check on a `.mjs` copy in `.claude-scratch/`.
- `.claude-scratch/smoke.cjs` (gitignored, may not exist) is a `vm`-based smoke test. It covers URL/storage resolution, double loading and blocked storage. It has no DOM, so it cannot test the injection or observer code.
- CI (`.github/workflows/hacs.yml`) only runs `hacs/action` with `category: plugin`. It validates the repo layout and `hacs.json`, not the JS.
- The real test is manual: load the file as a dashboard resource in a live HA instance and open a dashboard with `?navbar=bottom`.

## Architecture

The file is one IIFE with two independent parts, each in its own try/catch so one failing can't stop the other:

1. **Configuration card** (`navbar-position-configuration-card`), registered first.
   - It renders once and has a button that toggles the saved setting, then reloads the page.
   - It exists for the HA mobile apps, where users can't edit the URL.
   - `window.customCards` is created if missing, because HA doesn't create it.
   - `customElements.get` guards `define` against loading the file twice.
2. **Navbar logic** (`startNavbarPosition`).
   - It is guarded against running twice by `window.__navbarPositionStarted`.
   - `window.navbarPosition` no longer exists.

### How the position is resolved

`resolvePosition()` applies these rules:
- `?navbar_cache`: store `bottom` if `navbar=bottom`, otherwise clear the saved value.
- else `?navbar=...`: use it for this page load only (`top` overrides a saved `bottom`).
- else read the saved value.

Values are normalised, so only `bottom` is ever stored, under the `localStorage` key `navbar_position`. All storage access goes through try/catch helpers. The key and the URL params `navbar` / `navbar_cache` are a user-facing contract; keep them compatible.

### How the navbar is moved

- **Injected stylesheet.** One `<style id="navbar-position-style">` is *prepended* to each `hui-root` shadow root, so it sits before Lit's content. The id makes injection idempotent. The rules need `!important` because HA's own styles are adopted stylesheets.
- **Finding dashboards.** A bounded scan runs every 200 ms for up to 10 s (`SCAN_INTERVAL_MS` / `SCAN_DURATION_MS`). It starts on startup, on HA's `location-changed` event and on `popstate`; no timer runs permanently. A MutationObserver on each `ha-panel-lovelace` shadow root catches `hui-root` being recreated (raw config editor, error screen).
- **Header height.** A ResizeObserver on `.header` publishes `--navbar-position-header-height` on the `hui-root` host:
  - the measured border-box height (0px when the header is hidden, e.g. by kiosk-mode)
  - `0px` when a *previously tracked* header was removed
  - never set before Lit's first render. The panel observer fires while the new `hui-root`'s shadow root is still empty, so a missing `.header` there means "not rendered yet", not "removed". The CSS then falls back to `var(--header-height, 56px)`.
- **Padding.** `#view` padding-bottom is `max(header height, bottom safe area) + var(--view-container-padding-bottom, 0px)`. Padding-top is the top safe area plus `--view-container-padding-top`. Safe-area insets always use HA's variables with an `env()` fallback: `var(--safe-area-inset-*, env(safe-area-inset-*, 0px))`, so the companion app's injected insets are respected.

### Coupling to HA internals

This depends on HA frontend internals that are not a public API:

`home-assistant` → (shadow) `home-assistant-main` → (shadow) `ha-panel-lovelace` → (shadow) `hui-root` → (shadow) `.header` / `#view`

- `ha-drawer` and `partial-panel-resolver` are light DOM inside `home-assistant-main`'s shadow root, so one `querySelector` reaches `ha-panel-lovelace`.
- The router keeps one panel attached at a time and caches detached panels with their shadow DOM intact.
- If HA renames these elements, the plugin does nothing; a one-time "Navbar Position" console warning points at it. Check this chain first for "it stopped working" reports.
- Only the dashboard navbar is moved; navbars on other HA screens are out of scope.

## Conventions

- Keep the code readable for humans: small, well-named functions, named constants, and comments that explain *why*.
- `README.md` is rendered in HACS (`render_readme: true`), so it is user-facing. Keep it in sync when behaviour, URL params or the card's labels change.
- GitHub Actions are pinned to full commit SHAs with a trailing `# vX.Y.Z` comment, and checkout uses `persist-credentials: false`. Resolve new pins with `git ls-remote --tags <repo>`, because `gh` is not authenticated on this machine. The `ghcr.io/hacs/action:main` image stays unpinned by choice.
- Scratch files go in `.claude-scratch/` (gitignored).
