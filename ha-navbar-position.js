/*
 * Navbar Position: moves the Home Assistant dashboard navigation bar to the bottom.
 *
 * How it works
 * ------------
 * The dashboard header lives several shadow roots deep inside the HA frontend:
 *
 *   home-assistant -> home-assistant-main -> ha-panel-lovelace -> hui-root
 *
 * Between home-assistant-main and ha-panel-lovelace sit `ha-drawer` and
 * `partial-panel-resolver`, but they are plain (light DOM) children inside
 * home-assistant-main's shadow root, so one querySelector reaches the panel.
 *
 * Inside the hui-root shadow root, `.header` is the navbar and `#view` holds the
 * dashboard content. None of this is a public API, so a frontend release that
 * renames these elements makes the plugin silently do nothing.
 *
 * Instead of rewriting inline styles over and over, we add one <style> element
 * to each hui-root shadow root. A stylesheet keeps applying when HA re-renders
 * the header, so the navbar never jumps back to the top. Every new hui-root
 * (created when you open another dashboard) gets its own stylesheet once.
 *
 * Because the header can change height (edit mode, safe areas, kiosk-mode
 * hiding it), a ResizeObserver measures it and publishes the height as a CSS
 * custom property. The stylesheet uses that value as bottom padding for the
 * content, so the last cards are never hidden behind the navbar.
 *
 * How the setting is resolved (first match wins)
 * ----------------------------------------------
 *   1. `?navbar_cache` in the URL: save `navbar=bottom` to localStorage, or
 *      clear the saved value for anything else (`navbar=top` or no `navbar`).
 *   2. `?navbar=bottom` or `?navbar=top`: use it for this page load only.
 *   3. The value saved in localStorage under `navbar_position`.
 * Only `bottom` changes anything; every other value means "leave HA alone".
 *
 * The file also registers a small configuration card for devices where the URL
 * can't be edited (e.g. the HA mobile apps).
 *
 * Everything is wrapped in a function so that loading the file twice, or as a
 * classic script instead of a module, can't redeclare names or run twice.
 */
(() => {
  // User-facing contract: changing these breaks saved settings and bookmarks.
  const STORAGE_KEY = 'navbar_position';
  const URL_PARAM_POSITION = 'navbar';
  const URL_PARAM_SAVE = 'navbar_cache';
  const POSITION_BOTTOM = 'bottom';
  const POSITION_TOP = 'top';

  const CARD_TYPE = 'navbar-position-configuration-card';
  const CARD_GRID_COLUMNS = 6;
  const CARD_GRID_MIN_COLUMNS = 3;
  const STARTED_FLAG = '__navbarPositionStarted';
  const STYLE_ELEMENT_ID = 'navbar-position-style';
  const HEADER_HEIGHT_PROPERTY = '--navbar-position-header-height';

  // After a navigation, HA builds the new dashboard asynchronously, and we
  // can't observe nested shadow roots from the document. So we look for the
  // dashboard a few times a second for a short while after each navigation,
  // then stop. Re-applying is cheap and idempotent.
  const SCAN_INTERVAL_MS = 200;
  const SCAN_DURATION_MS = 10000;

  // `!important` is needed because HA's own hui-root styles are adopted
  // stylesheets, which win over a <style> element at equal specificity.
  // The safe-area values prefer HA's own variables (set by the companion apps)
  // and fall back to the browser's env() values.
  const SAFE_AREA_TOP = 'var(--safe-area-inset-top, env(safe-area-inset-top, 0px))';
  const SAFE_AREA_BOTTOM = 'var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))';

  // Until the header has been measured, estimate its height from HA's variable.
  const HEADER_HEIGHT = `var(${HEADER_HEIGHT_PROPERTY}, calc(var(--header-height, 56px) + ${SAFE_AREA_BOTTOM}))`;

  // The header already includes the bottom safe area. When it is hidden
  // (height 0), the content still needs to clear the home indicator, hence max().
  // The --view-container-padding-* variables keep HA's theme hooks working.
  const VIEW_PADDING_TOP = `calc(${SAFE_AREA_TOP} + var(--view-container-padding-top, 0px))`;
  const VIEW_PADDING_BOTTOM =
    `calc(max(${HEADER_HEIGHT}, ${SAFE_AREA_BOTTOM}) + var(--view-container-padding-bottom, 0px))`;

  const NAVBAR_AT_BOTTOM_CSS = `
    .header {
      top: auto !important;
      bottom: 0 !important;
      padding-top: 0 !important;
      padding-bottom: ${SAFE_AREA_BOTTOM} !important;
    }

    #view {
      padding-top: ${VIEW_PADDING_TOP} !important;
      padding-bottom: ${VIEW_PADDING_BOTTOM} !important;
    }
  `;

  // ---------------------------------------------------------------------------
  // Storage: localStorage can throw (private mode, disabled storage, sandboxed
  // webviews). A failure there must never stop the plugin or the card.
  // ---------------------------------------------------------------------------

  function readSavedPosition() {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      console.warn('Navbar Position: could not read the saved position.', error);
      return null;
    }
  }

  // Saves `bottom`, or clears the setting for anything else, because "top" is
  // simply HA's default. Returns whether the change was saved.
  function savePosition(position) {
    try {
      if (position === POSITION_BOTTOM) {
        window.localStorage.setItem(STORAGE_KEY, POSITION_BOTTOM);
      } else {
        window.localStorage.removeItem(STORAGE_KEY);
      }
      return true;
    } catch (error) {
      console.warn('Navbar Position: could not save the position.', error);
      return false;
    }
  }

  function isSavedAtBottom() {
    return readSavedPosition() === POSITION_BOTTOM;
  }

  // ---------------------------------------------------------------------------
  // Setting resolution
  // ---------------------------------------------------------------------------

  // Only `bottom` and `top` are meaningful; anything else is treated as `top`
  // so unexpected input can never end up in localStorage.
  function normalizePosition(value) {
    return value === POSITION_BOTTOM ? POSITION_BOTTOM : POSITION_TOP;
  }

  function resolvePosition() {
    const params = new URLSearchParams(window.location.search);
    const urlPosition = normalizePosition(params.get(URL_PARAM_POSITION));

    if (params.has(URL_PARAM_SAVE)) {
      savePosition(urlPosition);
      return urlPosition;
    }

    if (params.has(URL_PARAM_POSITION)) {
      return urlPosition;
    }

    return isSavedAtBottom() ? POSITION_BOTTOM : POSITION_TOP;
  }

  // ---------------------------------------------------------------------------
  // Moving the navbar
  // ---------------------------------------------------------------------------

  // Remembers which header each hui-root's ResizeObserver is watching.
  const headerTrackers = new WeakMap();
  // Panels whose shadow root we already observe for a replaced hui-root.
  const watchedPanels = new WeakSet();
  let hasWarnedAboutMissingHeader = false;

  function findLovelacePanel() {
    return document
      .querySelector('home-assistant')?.shadowRoot
      ?.querySelector('home-assistant-main')?.shadowRoot
      ?.querySelector('ha-panel-lovelace') ?? null;
  }

  function addStylesheetOnce(shadowRoot) {
    if (shadowRoot.getElementById(STYLE_ELEMENT_ID)) {
      return;
    }

    const style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    style.textContent = NAVBAR_AT_BOTTOM_CSS;
    // Prepend, so the element sits before the content Lit renders and manages,
    // and HA's re-renders can never touch or remove it.
    shadowRoot.prepend(style);
  }

  // The height is set on the hui-root element itself, so it is inherited by
  // everything inside its shadow root, including `#view`. A hidden header
  // (e.g. kiosk-mode) measures 0, so only the bottom safe-area inset remains.
  function publishHeaderHeight(huiRoot, header) {
    const height = header.getBoundingClientRect().height;
    huiRoot.style.setProperty(HEADER_HEIGHT_PROPERTY, `${height}px`);
  }

  function trackHeaderHeight(huiRoot) {
    const shadowRoot = huiRoot.shadowRoot;
    const header = shadowRoot.querySelector('.header');

    if (!header) {
      // A header we were tracking has been removed: there is nothing left to
      // make room for, so don't keep its old height. A hui-root that Lit has
      // not rendered yet also has no header, but that is not "removed": leave
      // the property unset so the stylesheet's --header-height estimate applies.
      if (headerTrackers.has(huiRoot)) {
        huiRoot.style.setProperty(HEADER_HEIGHT_PROPERTY, '0px');
      }

      // `#view` without `.header` means HA rendered the dashboard but the
      // navbar markup changed. Before the first render both are missing.
      if (shadowRoot.querySelector('#view')) {
        warnAboutMissingHeaderOnce();
      }
      return;
    }

    const tracker = headerTrackers.get(huiRoot);
    if (tracker?.header === header) {
      return;
    }
    tracker?.observer.disconnect();

    const observer = new ResizeObserver(() => {
      // If HA swapped the header element, start watching the new one.
      if (!header.isConnected) {
        trackHeaderHeight(huiRoot);
        return;
      }
      publishHeaderHeight(huiRoot, header);
    });
    observer.observe(header);
    headerTrackers.set(huiRoot, { header, observer });
  }

  function warnAboutMissingHeaderOnce() {
    if (hasWarnedAboutMissingHeader) {
      return;
    }
    hasWarnedAboutMissingHeader = true;
    console.warn(
      'Navbar Position: no ".header" found in the dashboard (hui-root). ' +
      'The Home Assistant frontend may have changed; the navbar was not moved.'
    );
  }

  function moveNavbarInHuiRoot(huiRoot) {
    if (!huiRoot.shadowRoot) {
      return;
    }
    addStylesheetOnce(huiRoot.shadowRoot);
    trackHeaderHeight(huiRoot);
  }

  function moveNavbarInPanel(panelShadowRoot) {
    const huiRoot = panelShadowRoot.querySelector('hui-root');
    if (huiRoot) {
      moveNavbarInHuiRoot(huiRoot);
    }
  }

  // The panel can replace its hui-root without a navigation (for example while
  // the dashboard reloads), so we also watch the panel itself.
  function watchPanelOnce(panelShadowRoot) {
    if (watchedPanels.has(panelShadowRoot)) {
      return;
    }
    watchedPanels.add(panelShadowRoot);

    const observer = new MutationObserver(() => moveNavbarInPanel(panelShadowRoot));
    observer.observe(panelShadowRoot, { childList: true, subtree: true });
  }

  function moveNavbarInCurrentDashboard() {
    const panelShadowRoot = findLovelacePanel()?.shadowRoot;
    if (!panelShadowRoot) {
      return;
    }
    watchPanelOnce(panelShadowRoot);
    moveNavbarInPanel(panelShadowRoot);
  }

  let scanTimer = null;
  let scanEndsAt = 0;

  // Starting a scan while one is running just extends it.
  function scanForDashboard() {
    scanEndsAt = Date.now() + SCAN_DURATION_MS;
    if (scanTimer === null) {
      runScanStep();
    }
  }

  function runScanStep() {
    scanTimer = null;

    try {
      moveNavbarInCurrentDashboard();
    } catch (error) {
      console.error('Navbar Position: error while moving the navbar.', error);
    }

    if (Date.now() < scanEndsAt) {
      scanTimer = setTimeout(runScanStep, SCAN_INTERVAL_MS);
    }
  }

  function startNavbarPosition() {
    if (window[STARTED_FLAG]) {
      return;
    }
    window[STARTED_FLAG] = true;

    if (resolvePosition() !== POSITION_BOTTOM) {
      return;
    }

    // HA fires `location-changed` on window for in-app navigation; `popstate`
    // covers the browser's back and forward buttons.
    window.addEventListener('location-changed', scanForDashboard);
    window.addEventListener('popstate', scanForDashboard);
    scanForDashboard();
  }

  // ---------------------------------------------------------------------------
  // Configuration card: toggles the saved position on this device.
  // ---------------------------------------------------------------------------

  class NavbarPositionConfigurationCard extends HTMLElement {
    setConfig(_config) {}

    connectedCallback() {
      if (this.button) {
        return;
      }

      const card = document.createElement('ha-card');
      const content = document.createElement('div');
      content.className = 'card-content';

      this.status = document.createElement('p');
      this.button = document.createElement('button');
      this.button.type = 'button';
      this.button.addEventListener('click', () => this.togglePosition());

      content.append(this.status, this.button);
      card.append(content);
      this.append(card);

      this.showSavedPosition();
    }

    showSavedPosition() {
      const isBottom = isSavedAtBottom();
      const savedPosition = isBottom ? POSITION_BOTTOM : POSITION_TOP;
      const otherPosition = isBottom ? POSITION_TOP : POSITION_BOTTOM;
      this.status.textContent = `Saved position on this device: ${savedPosition}`;
      this.button.textContent = `Move navigation bar to the ${otherPosition}`;
    }

    // Reloading is the simplest way to apply or undo the change everywhere.
    togglePosition() {
      const nextPosition = isSavedAtBottom() ? POSITION_TOP : POSITION_BOTTOM;
      if (savePosition(nextPosition)) {
        window.location.reload();
      } else {
        this.status.textContent =
          'Could not save the setting: storage is not available in this browser.';
      }
    }

    getCardSize() {
      return 1;
    }

    // Sections dashboards use a 12-column grid: default to half width, allow
    // shrinking to a quarter. Rows are left out so the height fits the content.
    getGridOptions() {
      return { columns: CARD_GRID_COLUMNS, min_columns: CARD_GRID_MIN_COLUMNS };
    }
  }

  function registerCard() {
    if (customElements.get(CARD_TYPE)) {
      return;
    }
    customElements.define(CARD_TYPE, NavbarPositionConfigurationCard);

    window.customCards = window.customCards || [];
    window.customCards.push({
      type: CARD_TYPE,
      name: 'Navbar Position Configuration Card',
      description: 'A simple card that allows toggling where the dashboard navigation bar is shown',
    });
  }

  // The card and the navbar logic are independent: one failing must not
  // prevent the other from working.
  try {
    registerCard();
  } catch (error) {
    console.error('Navbar Position: could not register the configuration card.', error);
  }

  try {
    startNavbarPosition();
  } catch (error) {
    console.error('Navbar Position: could not start.', error);
  }
})();
