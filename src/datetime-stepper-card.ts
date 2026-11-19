import { LitElement, html, css, nothing, type PropertyValues, type TemplateResult } from "lit";
import { localize, type StringKey } from "./localize";
import {
  DAY,
  MINUTE,
  floorMinute,
  formatNaive,
  instantFromWall,
  pad,
  parseNaive,
  partsFromWall,
  wallFromInstant,
} from "./time";

const CARD_VERSION = "0.1.2";

type Unit = "day" | "hour" | "minute";
type Layout = "row" | "card";
type QuickButton = "today" | "tomorrow";

export interface DateTimeStepperCardConfig {
  type: string;
  entity: string;
  name?: string;
  icon?: string;
  layout?: Layout;
  minute_step?: number;
  hour_step?: number;
  show_relative?: boolean;
  quick_buttons?: QuickButton[];
  commit_delay?: number;
  allow_past?: boolean;
}

/* Minimal slice of the Home Assistant frontend types used by this card. */
interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, any>;
}
interface HomeAssistant {
  states: Record<string, HassEntity>;
  config: { time_zone: string };
  locale?: { language?: string; time_format?: string; time_zone?: string };
  language?: string;
  callService(domain: string, service: string, data: Record<string, unknown>): Promise<unknown>;
}

interface EntityInfo {
  domain: "input_datetime" | "datetime";
  hasDate: boolean;
  hasTime: boolean;
  /** Wall time in the display time zone, or undefined when unknown. */
  wall?: number;
  available: boolean;
}

const PLUS = "M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z";
const MINUS = "M19,13H5V11H19V13Z";
const SUPPORTED_DOMAINS = ["input_datetime", "datetime"];
const REPEAT_DELAY = 450;
const REPEAT_START = 180;
const REPEAT_MIN = 50;

export class DateTimeStepperCard extends LitElement {
  static properties = {
    hass: { attribute: false },
    _config: { state: true },
    _pendingWall: { state: true },
    _timeUnit: { state: true },
    _now: { state: true },
  };

  declare hass: HomeAssistant;
  declare _config: DateTimeStepperCardConfig;
  declare _pendingWall: number | undefined;
  declare _timeUnit: "hour" | "minute";
  declare _now: number;

  private _commitTimer?: number;
  private _repeatTimer?: number;
  private _clockTimer?: number;
  private _pointerStep = false;
  private _awaitingState = false;

  constructor() {
    super();
    this._timeUnit = "hour";
    this._now = Date.now();
  }

  /* ---------- Lovelace API ---------- */

  setConfig(config: DateTimeStepperCardConfig): void {
    if (!config?.entity) throw new Error("You need to define an entity");
    const domain = config.entity.split(".")[0];
    if (!SUPPORTED_DOMAINS.includes(domain)) {
      throw new Error("Entity must be an input_datetime or datetime entity");
    }
    if (config.layout && !["row", "card"].includes(config.layout)) {
      throw new Error("layout must be 'row' or 'card'");
    }
    this._config = config;
  }

  getCardSize(): number {
    return this._layout === "card" ? 3 : 1;
  }

  getGridOptions() {
    // Height follows the content: the row layout wraps on narrow screens.
    return this._layout === "card"
      ? { columns: 12, rows: "auto", min_columns: 6 }
      : { columns: 12, rows: "auto", min_columns: 6 };
  }

  static getStubConfig(hass: HomeAssistant): Partial<DateTimeStepperCardConfig> {
    const entity =
      Object.keys(hass.states).find((id) => id.startsWith("input_datetime.")) ??
      Object.keys(hass.states).find((id) => id.startsWith("datetime.")) ??
      "input_datetime.example";
    return { entity, layout: "card" };
  }

  static getConfigForm() {
    return {
      schema: [
        { name: "entity", required: true, selector: { entity: { domain: SUPPORTED_DOMAINS } } },
        {
          type: "grid",
          name: "",
          schema: [
            { name: "name", selector: { text: {} } },
            { name: "icon", selector: { icon: {} }, context: { icon_entity: "entity" } },
          ],
        },
        {
          name: "layout",
          default: "card",
          selector: {
            select: {
              mode: "dropdown",
              options: [
                { value: "row", label: "Row (compact)" },
                { value: "card", label: "Card (large buttons)" },
              ],
            },
          },
        },
        {
          type: "grid",
          name: "",
          schema: [
            { name: "minute_step", default: 15, selector: { number: { min: 1, max: 60, mode: "box", unit_of_measurement: "min" } } },
            { name: "hour_step", default: 1, selector: { number: { min: 1, max: 12, mode: "box", unit_of_measurement: "h" } } },
            { name: "commit_delay", default: 1000, selector: { number: { min: 0, max: 10000, step: 100, mode: "box", unit_of_measurement: "ms" } } },
          ],
        },
        {
          name: "quick_buttons",
          selector: {
            select: {
              multiple: true,
              options: [
                { value: "today", label: "Today" },
                { value: "tomorrow", label: "Tomorrow" },
              ],
            },
          },
        },
        {
          type: "grid",
          name: "",
          schema: [
            { name: "show_relative", default: true, selector: { boolean: {} } },
            { name: "allow_past", default: true, selector: { boolean: {} } },
          ],
        },
      ],
      computeLabel: (s: { name: string }) =>
        ({
          entity: "Entity",
          name: "Name",
          icon: "Icon",
          layout: "Layout",
          minute_step: "Minute step",
          hour_step: "Hour step",
          commit_delay: "Save delay",
          quick_buttons: "Quick buttons",
          show_relative: "Show time remaining",
          allow_past: "Allow times in the past",
        })[s.name],
      computeHelper: (s: { name: string }) =>
        ({
          commit_delay: "Wait this long after the last tap before saving (0 = save on every tap)",
          minute_step: "Minutes snap to multiples of this value",
        })[s.name],
    };
  }

  /* ---------- Config helpers ---------- */

  private get _layout(): Layout {
    return this._config?.layout ?? "card";
  }
  private get _minuteStep(): number {
    return clampInt(this._config.minute_step, 1, 60, 15);
  }
  private get _hourStep(): number {
    return clampInt(this._config.hour_step, 1, 12, 1);
  }
  private get _commitDelay(): number {
    return clampInt(this._config.commit_delay, 0, 10_000, 1000);
  }
  private get _showRelative(): boolean {
    return this._config.show_relative ?? true;
  }
  private get _allowPast(): boolean {
    return this._config.allow_past ?? true;
  }
  private get _language(): string {
    return this.hass?.locale?.language ?? this.hass?.language ?? navigator.language ?? "en";
  }
  private _t(key: StringKey, vars?: Record<string, string>): string {
    return localize(this._language, key, vars);
  }

  /** Time zone the user wants to see times in (HA profile setting). */
  private get _displayTz(): string {
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return this.hass.locale?.time_zone === "server" ? this.hass.config.time_zone : browserTz;
  }

  private get _use12h(): boolean {
    const fmt = this.hass.locale?.time_format;
    if (fmt === "12") return true;
    if (fmt === "24") return false;
    const locale = fmt === "system" ? undefined : this._language;
    const cycle = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
    return cycle === "h11" || cycle === "h12";
  }

  /* ---------- Entity handling ---------- */

  private _entityInfo(): EntityInfo | undefined {
    const stateObj = this.hass?.states[this._config.entity];
    if (!stateObj) return undefined;
    const domain = this._config.entity.split(".")[0] as EntityInfo["domain"];
    const available = !["unavailable"].includes(stateObj.state);
    if (domain === "datetime") {
      const instant = Date.parse(stateObj.state);
      return {
        domain,
        hasDate: true,
        hasTime: true,
        available,
        wall: Number.isNaN(instant) ? undefined : wallFromInstant(instant, this._displayTz),
      };
    }
    const hasDate = stateObj.attributes.has_date !== false;
    const hasTime = stateObj.attributes.has_time !== false;
    let wall = parseNaive(stateObj.state);
    if (wall !== undefined && hasDate && hasTime) {
      // input_datetime stores naive wall time in the server time zone.
      wall = wallFromInstant(instantFromWall(wall, this.hass.config.time_zone), this._displayTz);
    }
    return { domain, hasDate, hasTime, available, wall };
  }

  private _nowWall(): number {
    return floorMinute(wallFromInstant(this._now, this._displayTz));
  }

  /** Starting point when the entity has no value yet: now, rounded up to the minute step. */
  private _defaultWall(info: EntityInfo): number {
    const step = this._minuteStep * MINUTE;
    const now = Math.ceil(this._nowWall() / step) * step;
    if (!info.hasDate) return now % DAY;
    if (!info.hasTime) return Math.floor(now / DAY) * DAY;
    return now;
  }

  private _currentWall(info: EntityInfo): number {
    return this._pendingWall ?? info.wall ?? this._defaultWall(info);
  }

  /* ---------- Lifecycle ---------- */

  connectedCallback(): void {
    super.connectedCallback();
    this._now = Date.now();
    this._clockTimer = window.setInterval(() => (this._now = Date.now()), 30_000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this._clockTimer);
    this._stopRepeat();
    if (this._commitTimer !== undefined) {
      window.clearTimeout(this._commitTimer);
      this._commitTimer = undefined;
      void this._commit();
    }
  }

  protected willUpdate(changed: PropertyValues): void {
    // Drop the local value once Home Assistant reports the saved state.
    if (changed.has("hass") && this._awaitingState && this._pendingWall !== undefined) {
      const info = this._entityInfo();
      if (info?.wall === this._pendingWall) {
        this._pendingWall = undefined;
        this._awaitingState = false;
      }
    }
  }

  /* ---------- Stepping ---------- */

  private _step(unit: Unit, dir: 1 | -1): void {
    const info = this._entityInfo();
    if (!info?.available) return;
    let wall = this._currentWall(info);

    if (unit === "day") {
      wall += dir * DAY;
    } else if (unit === "hour") {
      wall += dir * this._hourStep * 60 * MINUTE;
    } else {
      const step = this._minuteStep;
      const dayStart = Math.floor(wall / DAY) * DAY;
      const minutes = (wall - dayStart) / MINUTE;
      const next = dir > 0 ? Math.floor(minutes / step) * step + step : Math.ceil(minutes / step) * step - step;
      wall = dayStart + next * MINUTE;
    }

    if (!info.hasDate) wall = ((wall % DAY) + DAY) % DAY;
    this._setWall(this._clampPast(wall, info));
  }

  private _clampPast(wall: number, info: EntityInfo): number {
    if (this._allowPast || !info.hasDate) return wall;
    if (!info.hasTime) {
      const today = Math.floor(this._nowWall() / DAY) * DAY;
      return Math.max(wall, today);
    }
    const step = this._minuteStep * MINUTE;
    const min = Math.ceil(this._nowWall() / step) * step;
    return Math.max(wall, min);
  }

  private _setDay(offsetDays: number): void {
    const info = this._entityInfo();
    if (!info?.available) return;
    const wall = this._currentWall(info);
    const today = Math.floor(this._nowWall() / DAY) * DAY;
    const time = ((wall % DAY) + DAY) % DAY;
    this._setWall(this._clampPast(today + offsetDays * DAY + (info.hasTime ? time : 0), info));
  }

  private _setWall(wall: number): void {
    this._pendingWall = wall;
    this._awaitingState = false;
    window.clearTimeout(this._commitTimer);
    if (this._commitDelay === 0) {
      void this._commit();
    } else {
      this._commitTimer = window.setTimeout(() => {
        this._commitTimer = undefined;
        void this._commit();
      }, this._commitDelay);
    }
  }

  private async _commit(): Promise<void> {
    const info = this._entityInfo();
    const wall = this._pendingWall;
    if (!info || wall === undefined) return;
    if (wall === info.wall) {
      this._pendingWall = undefined;
      return;
    }
    this._awaitingState = true;
    const entity_id = this._config.entity;
    try {
      if (info.domain === "datetime") {
        const instant = instantFromWall(wall, this._displayTz);
        await this.hass.callService("datetime", "set_value", {
          entity_id,
          datetime: new Date(instant).toISOString().replace(/\.\d{3}Z$/, "+00:00"),
        });
      } else if (info.hasDate && info.hasTime) {
        const serverWall = wallFromInstant(instantFromWall(wall, this._displayTz), this.hass.config.time_zone);
        await this.hass.callService("input_datetime", "set_datetime", {
          entity_id,
          datetime: formatNaive(serverWall, true, true),
        });
      } else if (info.hasDate) {
        await this.hass.callService("input_datetime", "set_datetime", {
          entity_id,
          date: formatNaive(wall, true, false),
        });
      } else {
        await this.hass.callService("input_datetime", "set_datetime", {
          entity_id,
          time: formatNaive(wall, false, true),
        });
      }
      // Safety net: never keep showing a local value that Home Assistant did not confirm.
      window.setTimeout(() => {
        if (this._awaitingState && this._pendingWall === wall) {
          this._pendingWall = undefined;
          this._awaitingState = false;
        }
      }, 5000);
    } catch (err) {
      console.error("datetime-stepper-card: failed to save", err);
      this._pendingWall = undefined;
      this._awaitingState = false;
    }
  }

  /* ---------- Press and hold ---------- */

  private _onPointerDown(ev: PointerEvent, unit: Unit | "time", dir: 1 | -1): void {
    if (ev.button !== 0) return;
    this._pointerStep = true;
    const resolved = unit === "time" ? this._timeUnit : unit;
    this._step(resolved, dir);
    let delay = REPEAT_START;
    const repeat = () => {
      this._step(resolved, dir);
      delay = Math.max(REPEAT_MIN, delay * 0.85);
      this._repeatTimer = window.setTimeout(repeat, delay);
    };
    this._repeatTimer = window.setTimeout(repeat, REPEAT_DELAY);
  }

  private _stopRepeat = (): void => {
    window.clearTimeout(this._repeatTimer);
    this._repeatTimer = undefined;
  };

  private _onClick(unit: Unit | "time", dir: 1 | -1): void {
    // Pointer presses already stepped on pointerdown; clicks without a pointer come from the keyboard.
    if (this._pointerStep) {
      this._pointerStep = false;
      return;
    }
    this._step(unit === "time" ? this._timeUnit : unit, dir);
  }

  private _moreInfo(): void {
    this.dispatchEvent(
      new CustomEvent("hass-more-info", {
        detail: { entityId: this._config.entity },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /* ---------- Formatting ---------- */

  private _fmt(wall: number, opts: Intl.DateTimeFormatOptions): string {
    return new Intl.DateTimeFormat(this._language, { ...opts, timeZone: "UTC" }).format(new Date(wall));
  }

  private _hourLabel(wall: number): { hour: string; suffix?: string } {
    const { hour } = partsFromWall(wall);
    if (!this._use12h) return { hour: pad(hour) };
    return { hour: String(hour % 12 || 12), suffix: hour < 12 ? "AM" : "PM" };
  }

  private _relative(info: EntityInfo, wall: number): { text: string; past: boolean } | undefined {
    if (!this._showRelative || !info.hasDate || !info.hasTime) return undefined;
    const diff = Math.round((instantFromWall(wall, this._displayTz) - this._now) / MINUTE);
    if (diff === 0) return { text: this._t("now"), past: false };
    const abs = Math.abs(diff);
    const d = Math.floor(abs / 1440);
    const h = Math.floor((abs % 1440) / 60);
    const m = abs % 60;
    const parts: string[] = [];
    if (d) parts.push(`${d} ${this._t("day_short")}`);
    if (h) parts.push(`${h} ${this._t("hour_short")}`);
    if (m && !d) parts.push(`${m} ${this._t("minute_short")}`);
    const value = parts.join(" ");
    return diff > 0 ? { text: this._t("in", { value }), past: false } : { text: this._t("ago", { value }), past: true };
  }

  /* ---------- Rendering ---------- */

  private _stepButton(unit: Unit | "time", dir: 1 | -1, unitLabel: string): TemplateResult {
    return html`<button
      class="step"
      aria-label=${this._t(dir > 0 ? "increase" : "decrease", { unit: unitLabel })}
      @pointerdown=${(e: PointerEvent) => this._onPointerDown(e, unit, dir)}
      @pointerup=${this._stopRepeat}
      @pointerleave=${this._stopRepeat}
      @pointercancel=${this._stopRepeat}
      @click=${() => this._onClick(unit, dir)}
      @contextmenu=${(e: Event) => e.preventDefault()}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d=${dir > 0 ? PLUS : MINUS}></path></svg>
    </button>`;
  }

  private _header(info: EntityInfo, wall: number): TemplateResult {
    const stateObj = this.hass.states[this._config.entity];
    const name = this._config.name ?? stateObj.attributes.friendly_name ?? this._config.entity;
    const rel = info.available ? this._relative(info, wall) : undefined;
    return html`<div class="header" @click=${this._moreInfo}>
      <ha-state-icon
        class="icon"
        .hass=${this.hass}
        .stateObj=${stateObj}
        .icon=${this._config.icon}
      ></ha-state-icon>
      <div class="titles">
        <div class="name">${name}</div>
        ${!info.available
          ? html`<div class="secondary">${this._t("unavailable")}</div>`
          : rel
            ? html`<div class="secondary ${rel.past ? "past" : ""}">${rel.text}</div>`
            : nothing}
      </div>
    </div>`;
  }

  private _quickButtons(info: EntityInfo, wall: number): TemplateResult | typeof nothing {
    const buttons = info.hasDate ? (this._config.quick_buttons ?? []) : [];
    if (!buttons.length) return nothing;
    const today = Math.floor(this._nowWall() / DAY);
    const current = Math.floor(wall / DAY);
    return html`<div class="chips">
      ${buttons.map((b) => {
        const offset = b === "tomorrow" ? 1 : 0;
        return html`<button
          class="chip ${current - today === offset ? "active" : ""}"
          ?disabled=${!info.available}
          @click=${() => this._setDay(offset)}
        >
          ${this._t(b)}
        </button>`;
      })}
    </div>`;
  }

  private _renderRow(info: EntityInfo, wall: number): TemplateResult {
    const hour = this._hourLabel(wall);
    const minute = pad(partsFromWall(wall).minute);
    const unitButton = (unit: "hour" | "minute", label: string) =>
      html`<button
        class="unit ${this._timeUnit === unit ? "active" : ""}"
        aria-pressed=${this._timeUnit === unit}
        aria-label=${this._t("select_unit", { unit: this._t(unit === "hour" ? "hours" : "minutes") })}
        @click=${() => (this._timeUnit = unit)}
      >
        ${label}
      </button>`;
    return html`<div class="row ${info.available ? "" : "disabled"}">
      ${this._header(info, wall)}
      <div class="controls">
        ${this._quickButtons(info, wall)}
        ${info.hasDate
          ? html`<div class="segment">
              ${this._stepButton("day", -1, this._t("day"))}
              <span class="value day">${this._fmt(wall, { weekday: "short", day: "numeric", month: "short" })}</span>
              ${this._stepButton("day", 1, this._t("day"))}
            </div>`
          : nothing}
        ${info.hasTime
          ? html`<div class="segment">
              ${this._stepButton("time", -1, this._t(this._timeUnit === "hour" ? "hours" : "minutes"))}
              <span class="value time"
                >${unitButton("hour", hour.hour)}<span class="colon">:</span>${unitButton("minute", minute)}${hour.suffix
                  ? html`<span class="suffix">${hour.suffix}</span>`
                  : nothing}</span
              >
              ${this._stepButton("time", 1, this._t(this._timeUnit === "hour" ? "hours" : "minutes"))}
            </div>`
          : nothing}
      </div>
    </div>`;
  }

  private _renderCard(info: EntityInfo, wall: number): TemplateResult {
    const hour = this._hourLabel(wall);
    const minute = pad(partsFromWall(wall).minute);
    const column = (unit: Unit, value: string, label: string, aria: string) =>
      html`<div class="column">
        ${this._stepButton(unit, 1, aria)}
        <div class="big">${value}</div>
        <div class="label">${label}</div>
        ${this._stepButton(unit, -1, aria)}
      </div>`;
    return html`<div class="card ${info.available ? "" : "disabled"}">
      <div class="card-header">${this._header(info, wall)} ${this._quickButtons(info, wall)}</div>
      <div class="columns">
        ${info.hasDate
          ? column(
              "day",
              this._fmt(wall, { day: "numeric" }),
              `${this._fmt(wall, { weekday: "short" })} · ${this._fmt(wall, { month: "short" })}`,
              this._t("day"),
            )
          : nothing}
        ${info.hasDate && info.hasTime ? html`<div class="divider"></div>` : nothing}
        ${info.hasTime
          ? html`${column("hour", hour.hour, hour.suffix ?? this._t("hour_short"), this._t("hours"))}
              <div class="big colon">:</div>
              ${column("minute", minute, this._t("minute_short"), this._t("minutes"))}`
          : nothing}
      </div>
    </div>`;
  }

  protected render() {
    if (!this._config || !this.hass) return nothing;
    const info = this._entityInfo();
    if (!info) {
      return html`<ha-card
        ><div class="warning">${this._t("entity_not_found", { entity: this._config.entity })}</div></ha-card
      >`;
    }
    const wall = this._currentWall(info);
    return html`<ha-card class=${this._layout}>
      ${this._layout === "row" ? this._renderRow(info, wall) : this._renderCard(info, wall)}
    </ha-card>`;
  }

  static styles = css`
    :host {
      --dsc-button-size: 36px;
      --dsc-button-color: var(--secondary-background-color, rgba(127, 127, 127, 0.15));
      --dsc-accent: var(--state-icon-color, var(--primary-color));
    }
    ha-card {
      height: 100%;
      box-sizing: border-box;
      padding: 12px 16px;
    }
    .disabled .controls,
    .disabled .columns {
      opacity: 0.5;
      pointer-events: none;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 16px;
      min-width: 0;
      flex: 1 1 140px;
      cursor: pointer;
    }
    .row .header {
      gap: 12px;
      flex: 1 1 96px;
    }
    .icon {
      flex: none;
      width: 40px;
      display: flex;
      justify-content: center;
      color: var(--dsc-accent);
    }
    .titles {
      min-width: 0;
    }
    .name {
      font-size: 14px;
      color: var(--primary-text-color);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .secondary {
      font-size: 12px;
      color: var(--secondary-text-color);
    }
    .secondary.past {
      color: var(--error-color, #db4437);
    }
    button {
      font: inherit;
      color: inherit;
      border: none;
      background: none;
      padding: 0;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
    }
    button:focus-visible {
      outline: 2px solid var(--primary-color);
      outline-offset: 2px;
    }
    .step {
      flex: none;
      width: var(--dsc-button-size);
      height: var(--dsc-button-size);
      border-radius: 50%;
      background: var(--dsc-button-color);
      color: var(--primary-text-color);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      touch-action: manipulation;
      user-select: none;
      transition: background-color 120ms, transform 80ms;
    }
    .step:hover {
      background: color-mix(in srgb, var(--primary-color) 20%, var(--dsc-button-color));
    }
    .step:active {
      transform: scale(0.92);
    }
    .step svg {
      width: 20px;
      height: 20px;
      fill: currentColor;
    }
    .chips {
      display: flex;
      gap: 6px;
    }
    .chip {
      font-size: 12px;
      padding: 4px 12px;
      border-radius: 16px;
      border: 1px solid var(--divider-color);
      color: var(--secondary-text-color);
    }
    .chip.active {
      border-color: var(--primary-color);
      color: var(--primary-color);
      background: color-mix(in srgb, var(--primary-color) 12%, transparent);
    }

    /* Row layout */
    .row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px 16px;
    }
    .controls {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px 12px;
      margin-left: auto;
    }
    .row {
      --dsc-button-size: 32px;
    }
    .segment {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .value {
      font-size: 16px;
      font-weight: 500;
      text-align: center;
      color: var(--primary-text-color);
      font-variant-numeric: tabular-nums;
    }
    .value.day {
      min-width: 84px;
    }
    .value.time {
      display: inline-flex;
      align-items: baseline;
    }
    .unit {
      font-weight: 500;
      padding: 2px 3px;
      border-radius: 4px;
      border-bottom: 2px solid transparent;
    }
    .unit.active {
      color: var(--primary-color);
      border-bottom-color: var(--primary-color);
    }
    .suffix {
      font-size: 12px;
      margin-left: 4px;
      color: var(--secondary-text-color);
    }

    /* Card layout */
    .card-header {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 12px;
    }
    .columns {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 16px;
    }
    .column {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
    }
    .big {
      font-size: 30px;
      font-weight: 500;
      line-height: 1.1;
      min-width: 2.2ch;
      text-align: center;
      color: var(--primary-text-color);
      font-variant-numeric: tabular-nums;
    }
    .big.colon {
      min-width: 0;
      margin-top: -18px;
    }
    .label {
      font-size: 12px;
      color: var(--secondary-text-color);
      margin-top: -4px;
    }
    .divider {
      width: 1px;
      align-self: stretch;
      background: var(--divider-color);
      margin: 0 4px;
    }
    .warning {
      color: var(--error-color, #db4437);
    }
  `;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (value === undefined || value === null || value === "" || Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

if (!customElements.get("datetime-stepper-card")) {
  customElements.define("datetime-stepper-card", DateTimeStepperCard);
}

const w = window as unknown as { customCards?: unknown[] };
w.customCards = w.customCards || [];
w.customCards.push({
  type: "datetime-stepper-card",
  name: "DateTime Stepper Card",
  description: "Set a date and time with plus and minus buttons.",
  preview: true,
  documentationURL: "https://github.com/WorlockM/datetime-stepper-card",
});

console.info(`%c DATETIME-STEPPER-CARD %c v${CARD_VERSION} `, "color: white; background: #03a9f4; font-weight: 700;", "color: #03a9f4; background: white; font-weight: 700;");
