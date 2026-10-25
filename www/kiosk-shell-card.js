/*
 * kiosk-shell-card
 *
 * Wraps one screen's card and draws the row of navigation buttons along the
 * bottom. Every kiosk view uses it, so the buttons sit in the same place on
 * every screen and the content above them fills whatever is left.
 *
 * The buttons exist because `kiosk_mode` hides Home Assistant's header, and
 * with it the view tabs that would normally switch screens. Navigation uses
 * pushState plus a `location-changed` event, which is how Home Assistant's own
 * cards move between views. A plain link would reload the whole frontend, and
 * on the Pi 3B this runs on that costs around two minutes.
 */

class KioskShellCard extends HTMLElement {
  setConfig(config) {
    if (!config || !Array.isArray(config.nav) || !config.nav.length) {
      throw new Error("kiosk-shell-card: nav must be a non-empty list");
    }
    this._config = config;
    this._child = null;
    this._built = false;
    this.innerHTML = "";
  }

  getCardSize() {
    return 10;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    if (!this._built) this._build();
    if (this._child) this._child.hass = hass;
    this._checkAlert();
    this._markActive();
    this._injectCss();
  }

  /**
   * Jump to a screen when a watched entity turns on, so the doorbell camera
   * appears by itself when someone rings.
   *
   * Only a transition counts. Acting on the level instead would re-navigate on
   * every state update for as long as the sensor stayed on, which would trap
   * the screen and make the buttons useless. The first reading after a reload
   * is recorded without acting on it, so a sensor that happens to be on when
   * the kiosk starts does not count as a ring.
   */
  _checkAlert() {
    const alert = this._config.alert;
    if (!alert?.entity) return;

    const stateObj = this._hass.states[alert.entity];
    const current = stateObj ? stateObj.state : undefined;
    const previous = this._alertState;
    this._alertState = current;

    if (previous === undefined || previous === current) return;
    if (current !== (alert.to || "on")) return;
    this._navigate(alert.path);
  }

  async _build() {
    this._built = true;

    const card = document.createElement("ha-card");
    card.className = "kshell";

    const style = document.createElement("style");
    style.textContent = STYLES;
    card.appendChild(style);

    const content = document.createElement("div");
    content.className = "kshell-content";
    card.appendChild(content);

    const nav = document.createElement("nav");
    nav.className = "kshell-nav";
    this._buttons = this._config.nav.map((item) => {
      const button = document.createElement("button");
      button.className = "kshell-btn";
      button.type = "button";
      button.dataset.path = item.path;
      button.innerHTML = `
        <ha-icon icon="${item.icon || "mdi:circle-outline"}"></ha-icon>
        <span>${item.name}</span>`;
      button.addEventListener("click", () => this._navigate(item.path));
      nav.appendChild(button);
      return button;
    });
    card.appendChild(nav);

    this.appendChild(card);

    // The wrapped card is built through Home Assistant's own helpers so that
    // any card type works here, custom ones included.
    if (this._config.card) {
      const helpers = await window.loadCardHelpers();
      const child = helpers.createCardElement(this._config.card);
      if (this._hass) child.hass = this._hass;
      content.appendChild(child);
      this._child = child;
      this._injectCss();
    }

    // Keep the highlight right when navigation happens elsewhere, such as the
    // browser back button.
    const onMove = () => {
      this._markActive();
      this._resetIdle();
    };
    window.addEventListener("location-changed", onMove);
    window.addEventListener("popstate", onMove);
    this._markActive();
    this._startIdleWatch();
  }

  connectedCallback() {
    this._startIdleWatch();
  }

  disconnectedCallback() {
    this._stopIdleWatch();
  }

  /**
   * Return to the home screen after a period with no interaction.
   *
   * The listeners go on `window` with capture, so a tap anywhere counts,
   * including on a slider inside the wrapped card, and someone adjusting a
   * light is not interrupted mid-drag. The countdown is not running while the
   * home screen is already showing, so the kiosk sits on it indefinitely.
   */
  _startIdleWatch() {
    const idle = this._config?.idle_return;
    if (!idle?.path || !idle.seconds || this._idleHandler) return;

    this._idleHandler = () => this._resetIdle();
    for (const event of IDLE_EVENTS) {
      window.addEventListener(event, this._idleHandler, {
        capture: true,
        passive: true,
      });
    }
    this._resetIdle();
  }

  _stopIdleWatch() {
    if (this._idleHandler) {
      for (const event of IDLE_EVENTS) {
        window.removeEventListener(event, this._idleHandler, { capture: true });
      }
      this._idleHandler = null;
    }
    clearTimeout(this._idleTimer);
    this._idleTimer = null;
  }

  _resetIdle() {
    // The timestamp lives on window rather than on the element on purpose.
    // Home Assistant replaces a view's card element as it re-renders, and the
    // old instance's pending timer can still fire: during testing a screen
    // jumped home twelve seconds after arriving, ignoring interaction, because
    // the taps were resetting a newer instance while an orphan from the
    // previous one ran to completion. A shared timestamp makes every instance,
    // live or orphaned, agree on when the last interaction happened.
    window.__kioskLastInteraction = Date.now();
    this._armIdle();
  }

  _armIdle() {
    clearTimeout(this._idleTimer);
    this._idleTimer = null;

    const idle = this._config?.idle_return;
    if (!idle?.path || !idle.seconds) return;
    if (window.location.pathname === idle.path) return;

    const timeout = idle.seconds * 1000;
    const due = (window.__kioskLastInteraction || Date.now()) + timeout;

    this._idleTimer = setTimeout(() => {
      // Firing is not permission to navigate. A stale timer checks the shared
      // timestamp and puts itself back to sleep for whatever is left.
      const remaining = (window.__kioskLastInteraction || 0) + timeout - Date.now();
      if (remaining > 50) {
        this._armIdle();
        return;
      }
      if (window.location.pathname === idle.path) return;
      this._navigate(idle.path);
    }, Math.max(due - Date.now(), 250));
  }

  /**
   * Push a stylesheet into the wrapped card's shadow root.
   *
   * A last resort, for a third-party card whose layout cannot be reached any
   * other way. The trash card is the case this exists for: in its icon style
   * it hardcodes `grid-template-columns` to four fixed columns and ignores its
   * own items_per_row option, so on a 720px panel it draws a thin strip across
   * the top and leaves the rest empty. Custom properties inherit through a
   * shadow boundary but that grid is a literal, not a variable, so nothing
   * short of a stylesheet inside the root will do.
   *
   * It is re-checked on every state update because a re-render can drop
   * anything appended to the root.
   */
  _injectCss() {
    const css = this._config.card_css;
    if (!css || !this._child) return;

    const root = this._child.shadowRoot;
    if (!root) {
      // The card may not have rendered yet; try again shortly, but give up
      // rather than spin forever on a card that has no shadow root at all.
      this._cssTries = (this._cssTries || 0) + 1;
      if (this._cssTries < 50) setTimeout(() => this._injectCss(), 100);
      return;
    }

    // Every shadow root beneath the card gets a copy, not just the card's own.
    // A card built from nested custom elements keeps the part worth restyling
    // a level or two down: the trash card's .icons-container lives inside
    // trash-card-icons-container, so a stylesheet in the outer root does
    // nothing at all. Styles do not cross a shadow boundary, so the only way
    // to reach it is to put one in every root.
    const roots = [];
    const collect = (node, depth) => {
      if (!node || depth > 6) return;
      roots.push(node);
      for (const el of node.querySelectorAll("*")) {
        if (el.shadowRoot) collect(el.shadowRoot, depth + 1);
      }
    };
    collect(root, 0);

    for (const target of roots) {
      if (target.querySelector("style[data-kiosk-shell]")) continue;
      const style = document.createElement("style");
      style.setAttribute("data-kiosk-shell", "");
      style.textContent = css;
      target.appendChild(style);
    }
  }

  _navigate(path) {
    if (!path || window.location.pathname === path) return;
    window.history.pushState(null, "", path);
    window.dispatchEvent(new Event("location-changed", { composed: true }));
  }

  _markActive() {
    if (!this._buttons) return;
    const here = window.location.pathname;
    for (const button of this._buttons) {
      button.classList.toggle("kshell-active", button.dataset.path === here);
    }
  }
}

// Anything that counts as someone being present at the panel.
const IDLE_EVENTS = ["pointerdown", "touchstart", "keydown", "wheel"];

const STYLES = `
ha-card.kshell {
  height: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  border: none;
  background: none;
  box-shadow: none;
}
/* The screen's own card takes everything the buttons do not.
 *
 * overflow: hidden matters as much as flex: 1 here. The nav is only safe from
 * being pushed off the bottom if the content area cannot grow past its share:
 * a tall child, such as a camera image at its natural aspect ratio, otherwise
 * stretches this box and shoves the buttons off the 720px panel. Clipping a
 * screen's content is the lesser fault - the buttons are the way off a screen,
 * so they must always be reachable. */
.kshell-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
}
.kshell-content > * {
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.kshell-nav {
  flex: none;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 8px;
  padding: 8px 10px 10px;
}
.kshell-btn {
  /* Sized for a finger on a 720px-wide panel: four buttons across gives each
     one roughly 170px, and 72px of height clears the usual 48px target. */
  min-height: 72px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 6px 4px;
  border: 2px solid var(--divider-color, #d4d9de);
  border-radius: 10px;
  background: var(--card-background-color, #fff);
  color: var(--secondary-text-color, #727272);
  font: inherit;
  font-size: 15px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.kshell-btn ha-icon { --mdc-icon-size: 28px; }
.kshell-btn span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
.kshell-btn:active { transform: scale(0.97); }
.kshell-active {
  border-color: var(--pfc-flow-color, #2f7fd1);
  color: var(--pfc-flow-color, #2f7fd1);
  font-weight: 500;
}
`;

customElements.define("kiosk-shell-card", KioskShellCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "kiosk-shell-card",
  name: "Kiosk Shell Card",
  description: "Wraps a card and adds the kiosk's bottom navigation buttons.",
});
