/*
 * power-flow-card
 *
 * Boxes for grid, solar, AC loads and the EV charger, joined by lines that
 * animate in the direction the power is actually moving, with the per-phase
 * figures listed under each total.
 *
 * Written as a plain custom element with no framework and no build step. The
 * kiosk it was made for is a Raspberry Pi 3B driving a 720x720 panel, so the
 * DOM is built once and later updates only touch textContent and a couple of
 * class names. Nothing re-renders on a state change.
 */

const UNIT_SCALE = { W: 1, kW: 1000, MW: 1000000 };

// Below this many watts a flow counts as idle: no animation, muted line. Phase
// sensors jitter by a watt or two even with everything off.
const IDLE_WATTS = 5;

function toWatts(stateObj) {
  if (!stateObj) return null;
  const value = Number(stateObj.state);
  if (!Number.isFinite(value)) return null;
  const unit = stateObj.attributes?.unit_of_measurement || "W";
  return value * (UNIT_SCALE[unit] ?? 1);
}

function formatPower(watts) {
  if (watts === null) return { value: "--", unit: "W" };
  const magnitude = Math.abs(watts);
  if (magnitude >= 1000) {
    // One decimal once it crosses into kW.
    return { value: (watts / 1000).toFixed(1), unit: "kW" };
  }
  return { value: String(Math.round(watts)), unit: "W" };
}

const ICONS = {
  grid: "M12 2 7 7h3v4H4l-2 11h4l1-8h2v8h2v-8h2l1 8h4L16 11h-6V7h3z",
  solar:
    "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0-5v3m0 14v3M2 12h3m14 0h3M4.9 4.9l2.1 2.1m10 10 2.1 2.1m0-14.2-2.1 2.1m-10 10-2.1 2.1",
  load: "M3 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0",
  ev: "M5 4h8a2 2 0 0 1 2 2v12H3V6a2 2 0 0 1 2-2zm10 6h2l2 2v5a2 2 0 0 1-2 2M6 7h6v4H6z",
};

class PowerFlowCard extends HTMLElement {
  static getStubConfig() {
    return {
      type: "custom:power-flow-card",
      grid: { entity: "sensor.grid_power" },
      solar: { entity: "sensor.solar_power" },
    };
  }

  setConfig(config) {
    if (!config || typeof config !== "object") {
      throw new Error("power-flow-card: no configuration");
    }
    if (!config.grid && !config.solar && !config.loads && !config.ev) {
      throw new Error(
        "power-flow-card: configure at least one of grid, solar, loads, ev"
      );
    }
    this._config = config;
    this._nodes = null; // rebuilt lazily, so a config change redraws cleanly
    this.innerHTML = "";
  }

  getCardSize() {
    return 10;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    if (!this._nodes) this._build();
    this._update();
  }

  /** Read one configured box into plain numbers. */
  _readBox(key) {
    const spec = this._config[key];
    if (!spec) return null;
    const hass = this._hass;

    const phases = (spec.phases || [])
      .map((entityId) => toWatts(hass.states[entityId]))
      .filter((value) => value !== null);

    let total = spec.entity ? toWatts(hass.states[spec.entity]) : null;
    // AC loads have no total sensor on this system, only the three phases, so
    // fall back to the sum rather than leaving the box blank.
    if (total === null && phases.length) {
      total = phases.reduce((sum, value) => sum + value, 0);
    }
    if (spec.invert && total !== null) total = -total;

    return { total, phases, label: spec.name || key };
  }

  _build() {
    const config = this._config;
    const boxOrder = [
      ["grid", "topLeft"],
      ["solar", "bottomLeft"],
      ["loads", "topRight"],
      ["ev", "bottomRight"],
    ].filter(([key]) => config[key]);

    const card = document.createElement("ha-card");
    card.className = "pfc";

    const style = document.createElement("style");
    style.textContent = STYLES;
    card.appendChild(style);

    const stage = document.createElement("div");
    stage.className = "pfc-stage";

    // The connector lines sit in their own column, in an SVG whose geometry is
    // recomputed in pixels whenever the card is resized.
    stage.insertAdjacentHTML("beforeend", LINES_SVG);

    this._nodes = { lines: {}, arrows: {}, boxes: {} };
    this._svg = stage.querySelector(".pfc-lines");
    this._lineGroup = stage.querySelector(".pfc-line-group");
    this._arrowGroup = stage.querySelector(".pfc-arrow-group");

    const svgNS = "http://www.w3.org/2000/svg";
    for (const name of ["grid", "solar", "bus", "loads", "ev"]) {
      const path = document.createElementNS(svgNS, "path");
      path.setAttribute("class", name === "bus" ? "pfc-line pfc-bus" : "pfc-line");
      this._lineGroup.appendChild(path);
      this._nodes.lines[name] = path;

      if (name === "bus") continue;
      const arrow = document.createElementNS(svgNS, "path");
      arrow.setAttribute("class", "pfc-arrow");
      this._arrowGroup.appendChild(arrow);
      this._nodes.arrows[name] = arrow;
    }

    this._resizeObserver = new ResizeObserver(() => this._layoutLines());
    this._resizeObserver.observe(this._svg);

    for (const [key, position] of boxOrder) {
      const spec = config[key];
      const box = document.createElement("div");
      box.className = `pfc-box pfc-${position}`;
      box.innerHTML = `
        <div class="pfc-head">
          <svg class="pfc-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="${ICONS[spec.icon || key] || ICONS.load}"/>
          </svg>
          <span class="pfc-name"></span>
        </div>
        <div class="pfc-value">
          <span class="pfc-number">--</span><span class="pfc-unit">W</span>
        </div>
        <div class="pfc-phases"></div>
        <div class="pfc-extra"></div>`;
      stage.appendChild(box);

      this._nodes.boxes[key] = {
        root: box,
        name: box.querySelector(".pfc-name"),
        number: box.querySelector(".pfc-number"),
        unit: box.querySelector(".pfc-unit"),
        phases: box.querySelector(".pfc-phases"),
        extra: box.querySelector(".pfc-extra"),
        phaseRows: null,
      };
    }

    card.appendChild(stage);
    this.appendChild(card);
  }

  _update() {
    const config = this._config;

    for (const key of ["grid", "solar", "loads", "ev"]) {
      const node = this._nodes.boxes[key];
      if (!node) continue;
      const data = this._readBox(key);
      const spec = config[key];

      node.name.textContent = data.label;

      const { value, unit } = formatPower(data.total);
      node.number.textContent = value;
      node.unit.textContent = unit;

      // Phase rows are created once; after that only the numbers change.
      if (!node.phaseRows) {
        node.phaseRows = data.phases.map((_, index) => {
          const row = document.createElement("div");
          row.className = "pfc-phase";
          row.innerHTML = `<span>L${index + 1}:</span><span class="pfc-pv"></span>`;
          node.phases.appendChild(row);
          return row.querySelector(".pfc-pv");
        });
      }
      data.phases.forEach((watts, index) => {
        const cell = node.phaseRows[index];
        if (!cell) return;
        const formatted = formatPower(watts);
        cell.textContent = `${formatted.value} ${formatted.unit}`;
      });

      if (spec.secondary) {
        const stateObj = this._hass.states[spec.secondary];
        node.extra.textContent = stateObj
          ? `${stateObj.state} ${stateObj.attributes.unit_of_measurement || ""}`.trim()
          : "";
      }

      const line = this._nodes.lines[key];
      if (line) this._applyFlow(line, key, data.total);
    }
  }

  /**
   * Place the connectors in pixel coordinates.
   *
   * Called from a ResizeObserver, so it also runs once on first layout. The
   * two rows of boxes have their middles at a quarter and three quarters of
   * the height, which is where the horizontal runs meet them.
   */
  _layoutLines() {
    if (!this._svg) return;
    const width = this._svg.clientWidth;
    const height = this._svg.clientHeight;
    if (!width || !height) return;

    this._svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    const mid = width / 2;
    const top = Math.round(height * 0.25);
    const bottom = Math.round(height * 0.75);
    this._geometry = { width, mid, top, bottom };

    this._nodes.lines.grid.setAttribute("d", `M0 ${top} H${mid}`);
    this._nodes.lines.solar.setAttribute("d", `M0 ${bottom} H${mid}`);
    this._nodes.lines.bus.setAttribute("d", `M${mid} ${top} V${bottom}`);
    this._nodes.lines.loads.setAttribute("d", `M${mid} ${top} H${width}`);
    this._nodes.lines.ev.setAttribute("d", `M${mid} ${bottom} H${width}`);

    this._update();
  }

  /** An arrowhead centred at x,y, pointing right when `rightward`. */
  _arrowPath(x, y, rightward) {
    const tip = rightward ? x + ARROW : x - ARROW;
    const back = rightward ? x - ARROW : x + ARROW;
    return `M${tip} ${y} L${back} ${y - ARROW} L${back} ${y + ARROW} Z`;
  }

  /**
   * Set a connector's direction and liveliness.
   *
   * Sign conventions differ per box, so they are resolved here rather than in
   * the markup: a positive grid reading is power coming in, a positive load or
   * EV reading is power going out, and solar only ever produces. A negative
   * grid reading is export, which is the case that makes the direction worth
   * showing at all.
   */
  _applyFlow(line, key, watts) {
    const idle = watts === null || Math.abs(watts) < IDLE_WATTS;
    line.classList.toggle("pfc-idle", idle);

    const arrow = this._nodes.arrows[key];

    if (idle) {
      line.classList.remove("pfc-reverse");
      // Clear the shape rather than recolouring it. Leaving a grey arrowhead
      // behind would mean an idle connector showed a direction if it had been
      // active earlier and none if it never had, which reads as a glitch.
      if (arrow) arrow.removeAttribute("d");
      return;
    }
    const reversed = watts < 0;
    line.classList.toggle("pfc-reverse", reversed);
    line.classList.toggle("pfc-still", this._config.animate === false);

    if (!arrow || !this._geometry) return;
    const { width, mid, top, bottom } = this._geometry;
    // Left-hand boxes feed the bus, right-hand boxes are fed from it, so for
    // a positive reading both arrows point the same way: toward the centre on
    // the left, away from it on the right.
    const onLeft = key === "grid" || key === "solar";
    const x = onLeft ? mid / 2 : mid + (width - mid) / 2;
    const y = key === "grid" || key === "loads" ? top : bottom;
    arrow.setAttribute("d", this._arrowPath(x, y, !reversed));
  }
}

/*
 * The connectors live in their own column between the two columns of boxes,
 * rather than in an overlay. An overlay put the horizontal segments underneath
 * the boxes, where nothing could be seen of them.
 *
 * The SVG is laid out in real pixels, its viewBox set from a ResizeObserver,
 * rather than in a stretched 0-100 space. A percentage viewBox needs
 * preserveAspectRatio="none", which squashes x by about sevenfold in a column
 * this narrow and tall: lines survive that, but an arrowhead drawn in it comes
 * out as a smear. Pixel coordinates keep the arrows the shape they are drawn.
 */
const LINES_SVG = `
<svg class="pfc-lines" aria-hidden="true">
  <g class="pfc-line-group"></g>
  <g class="pfc-arrow-group"></g>
</svg>`;

// Half-width and half-height of an arrowhead, in pixels.
const ARROW = 11;

const STYLES = `
/*
 * The card fills whatever the panel view gives it rather than claiming a fixed
 * square. On the 720x720 kiosk, with the Home Assistant header hidden, that is
 * the whole screen; in a browser window it simply follows the window. An
 * aspect-ratio here made the card taller than the viewport and cut the bottom
 * row off.
 */
ha-card.pfc {
  height: 100%;
  box-sizing: border-box;
  display: flex;
}
.pfc-stage {
  flex: 1;
  display: grid;
  grid-template-columns: 1fr var(--pfc-bus-width, 132px) 1fr;
  grid-template-rows: 1fr 1fr;
  gap: 10px;
  padding: 10px;
  box-sizing: border-box;
  min-height: 0;
}
.pfc-lines {
  grid-area: 1 / 2 / 3 / 3;
  width: 100%;
  height: 100%;
  pointer-events: none;
  align-self: stretch;
}
/* Everything here is in pixels, because the viewBox is set from the SVG's own
   size. The dashes were 3px long on a 3px line and read as a faint hairline at
   arm's length; at 11px on a 6px line they are legible across a room. */
.pfc-line {
  fill: none;
  stroke: var(--pfc-flow-color, #2f7fd1);
  stroke-width: 6;
  stroke-linecap: butt;
}
.pfc-line:not(.pfc-bus) {
  stroke-dasharray: 11 9;
  animation: pfc-move 1.1s linear infinite;
}
.pfc-line.pfc-reverse { animation-direction: reverse; }
.pfc-line.pfc-still   { animation: none; }
.pfc-line.pfc-idle {
  animation: none;
  stroke-dasharray: none;
  stroke: var(--pfc-idle-color, #b9c6d4);
}
@keyframes pfc-move { to { stroke-dashoffset: -20; } }

/* The arrowhead says which way the power is going without having to watch the
   dashes move, which matters for the grid: import and export look identical
   on a still screen otherwise. */
.pfc-arrow {
  fill: var(--pfc-flow-color, #2f7fd1);
  stroke: none;
}
.pfc-arrow.pfc-idle { fill: var(--pfc-idle-color, #b9c6d4); }

@media (prefers-reduced-motion: reduce) {
  .pfc-line:not(.pfc-bus) { animation: none; }
}

.pfc-box {
  position: relative;
  /* The big reading is sized against the box rather than the viewport, so a
     box keeps its proportions whatever the panel size. */
  container-type: inline-size;
  background: var(--card-background-color, #fff);
  border: 2px solid var(--pfc-flow-color, #2f7fd1);
  border-radius: 10px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}
.pfc-topLeft     { grid-area: 1 / 1; }
.pfc-bottomLeft  { grid-area: 2 / 1; }
.pfc-topRight    { grid-area: 1 / 3; }
.pfc-bottomRight { grid-area: 2 / 3; }

.pfc-head { display: flex; align-items: center; gap: 6px; }
.pfc-icon {
  width: 18px; height: 18px; flex: none;
  fill: none;
  stroke: var(--primary-text-color, #212121);
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.pfc-name {
  font-size: 15px;
  color: var(--primary-text-color, #212121);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/*
 * The reading fills the space between the header and the phase rows, centred
 * both ways. 28cqw is chosen against the widest reading this system can
 * produce: the EV charger at full tilt reads 11000 W, which formats as
 * "11.0 kW", and an export of the same size adds a minus sign. Measured in
 * the browser at a 267px box, "-11.0 kW" then draws 210px wide, leaving about
 * 57px spare. Because the digits are tabular, any two-digit kW value is the
 * same width, so this holds for a 25 kW peak as much as an 11 kW one. Only a
 * three-digit kW reading would overrun, which this house cannot produce.
 */
.pfc-value {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.06em;
  min-height: 0;
  font-size: clamp(24px, 28cqw, 120px);
  line-height: 1;
}
.pfc-number {
  font-size: 1em;
  color: var(--primary-text-color, #212121);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.pfc-unit {
  font-size: 0.42em;
  color: var(--secondary-text-color, #727272);
  align-self: center;
}

.pfc-phases { margin-top: 0; }
.pfc-phase {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  color: var(--secondary-text-color, #727272);
  font-variant-numeric: tabular-nums;
}
.pfc-extra {
  font-size: 12px;
  color: var(--secondary-text-color, #727272);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
`;

customElements.define("power-flow-card", PowerFlowCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "power-flow-card",
  name: "Power Flow Card",
  description: "Power flow between grid, solar, house and an EV charger.",
});
