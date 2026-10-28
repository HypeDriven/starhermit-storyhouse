// The look of the HUD, rails, tray, screens and overlays: the browser build's
// styles.css, rewritten class-based in tools/ui-style.css and converted once
// with `starhermit css` into assets/ui-style.json (`npm run css`), registered
// at start with the theme the runtime's own widgets (scroll bars, focus
// rings, selects, sliders, text fields) take. The colour palettes
// (html.palette-protan / deutan / tritan: the good, bad and card colours) are
// the game's option; high contrast is the runtime's (the old
// html.high-contrast token set).
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";
import type { Palette } from "./platform.ts";

type Tokens = Record<string, string>;
const BASE: Tokens = {
  ink: "#f4eef2", "ink-dim": "#c9bcc6", paper: "#241d2b", "paper-2": "#2f2637", "paper-3": "#3b2f45", line: "#4a3c56",
  brand: "#e8b04a", "brand-ink": "#2a1f10", good: "#7fb069", bad: "#d95d4e", card: "#9a7fc9", focus: "#ffd166",
  bar: "#2f2637e0", "rail-bg": "#2f2637e6", "screen-bg": "#241d2bd1", "lesson-bg": "#503e46", "tray-on": "#5e4946",
};
const PALETTES: Record<Palette, Tokens> = {
  default: {},
  protan: { good: "#4a9ad9", bad: "#e07b39", card: "#c9a24a" },
  deutan: { good: "#4a9ad9", bad: "#e0b03a", card: "#8a7fe0" },
  tritan: { good: "#4ac9a8", bad: "#d95d8a", card: "#c9a24a" },
};
const CONTRAST: Tokens = {
  ink: "#ffffff", "ink-dim": "#e8e8e8", paper: "#120e18", "paper-2": "#1c1626", "paper-3": "#282038", line: "#8a7a9a",
  brand: "#ffd166", focus: "#ffffff", bar: "#1c1626f0", "rail-bg": "#1c1626f5", "screen-bg": "#120e18e6", "lesson-bg": "#3c3230", "tray-on": "#4a3e36",
};

let current: Tokens = { ...BASE };
let key = "";
export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  ui.setFont({ family: "sans-serif" });
  ui.setTheme({
    fontSize: 16, smallSize: 13.6, headingSize: 20, padding: 8, spacing: 8, radius: 12,
    text: BASE.ink!, muted: BASE["ink-dim"]!, panel: BASE["paper-2"]!, control: BASE["paper-3"]!, hovered: BASE.line!,
    pressed: "#5a4a68", field: BASE["paper-3"]!, accent: BASE.brand!, focus: BASE.focus!, outline: BASE.line!,
  });
  ui.setTokens(css.tokens);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    heading: { text: { color: "$ink" } },
    widget: { focusRing: { color: "$focus", width: 3, offset: 2 } },
    scrollArea: { parts: { bar: { background: "$line", radius: 4 } } },
    tooltip: { background: "$paper-2", text: { color: "$ink" }, radius: 6, padding: 6 },
    // .overlay: rgba(12, 8, 18, 0.6) behind the cards.
    dialog: { background: "#00000000", padding: 0, parts: { backdrop: { background: "#0c081299" } } },
  });
  key = "";
}
/** The base, palette and high-contrast tokens (cheap when unchanged). */
export function applyTokens(palette: Palette, highContrast: boolean): void {
  const k = `${palette}:${highContrast}`;
  if (k === key) return;
  key = k;
  current = { ...BASE, ...(highContrast ? CONTRAST : {}), ...PALETTES[palette] };
  ui.setTokens(current);
  ui.setTheme({
    text: current.ink!, muted: current["ink-dim"]!, panel: current["paper-2"]!, control: current["paper-3"]!, hovered: current.line!,
    field: current["paper-3"]!, accent: current.brand!, focus: current.focus!, outline: current.line!,
  });
}
/** A token's current colour (for draw calls, which take real colours). */
export function token(name: string): string { return current[name] ?? "#000000"; }
