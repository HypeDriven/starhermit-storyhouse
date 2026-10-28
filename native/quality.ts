// The look per graphics level: the browser build's four presets and budgets
// (src/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// its Auto gave it) keyed by the runtime's quality tier (frame().quality),
// with the spark pool and the dust motes scaled within the tier by the level
// (frame().levelIndex, at most 1.5×), as the browser build scaled them by its
// hardware level. The runtime owns the rest of what the old Graphics panel
// did: Auto and the level choice, render scale and the pixel-ratio cap,
// adaptive resolution, the frame-rate limit and readout, the GPU summary. The
// old panel's per-category overrides are not offered (the runtime's Options
// choose a level).
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** House, tray and piece shading: Lambert (Low), Standard (Balanced), clear-coated Physical glazed pieces (High, Ultra). */
  material: "lambert" | "standard" | "physical";
  /** Curved-mesh segment multiplier (characters, props, room dressing, ground). */
  seg: number;
  /** Spark pool at Particles "high" (low: a quarter). */
  particles: number;
  /** Dust motes drifting through the rooms (Particles high). */
  motes: number;
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: QualityTier;
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  reflections: boolean;
  /** Floorboards, wallpaper and grain patterns, glowing panes, bookshelves, flowerbeds, stepping stones. */
  detailed: boolean;
  particles: "low" | "high";
  /** The furnished house behind the title: none, still, or with a slow camera sway. */
  backdrop: "off" | "static" | "animated";
  budget: Budget;
}

/** gfx.js TABLE (the cap and render scale are the runtime's). */
const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "msaa", reflections: false, detailed: false, particles: "low", backdrop: "off" },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, detailed: true, particles: "high", backdrop: "static" },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, detailed: true, particles: "high", backdrop: "animated" },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, detailed: true, particles: "high", backdrop: "animated" },
};
/** gfx.js BUDGETS. */
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", seg: 0.6, particles: 800, motes: 60, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", seg: 0.8, particles: 2000, motes: 100, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", seg: 1, particles: 4000, motes: 140, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", seg: 1.5, particles: 5000, motes: 220, bloomRes: 1, aoRes: 1 },
};
export const PARTICLE_MAX = 7500;
export const MOTE_MAX = 330;
/** The first level index of each tier. */
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };
const PARTICLE_SHARE = { low: 0.25, high: 1 };

/** The look for a quality tier at a level index (0 … 9). */
export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  const k = Math.min(1.5, Math.pow(1.22, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.particles = Math.min(PARTICLE_MAX, Math.round(b.particles * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return { preset, ...TABLE[preset], budget: b };
}
/** gfx.js particleCap: the live spark pool. */
export function particleCap(l: Look): number { return Math.round(l.budget.particles * PARTICLE_SHARE[l.particles]); }
