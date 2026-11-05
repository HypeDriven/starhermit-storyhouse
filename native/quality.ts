// The look per graphics level. Engine-owned effects (shadows and their map
// size, ambient occlusion, bloom, the grade, anti-aliasing) come from the level
// (levelSettings()); the browser build's art columns (src/gfx.js TABLE /
// BUDGETS: shading, segments, reflections, patterns, spark pool, motes,
// backdrop) stay keyed by the runtime's quality tier (frame().quality), with
// the spark pool and the dust motes scaled within the tier by the level's
// particle budget (at most 1.5×). The runtime owns the rest of what the old
// Graphics panel did: Auto and the level choice, render scale and the
// pixel-ratio cap, adaptive resolution, the frame-rate limit and readout, the
// GPU summary. The old panel's per-category overrides are not offered (the
// runtime's Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
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
}
export interface Look {
  preset: QualityTier;
  /** The level's shadow map size, 0 = off. */
  shadows: number;
  /** The level's ambient occlusion, null = off. */
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution, null = off. */
  bloom: number | null;
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

/** gfx.js TABLE's art columns (the cap and render scale are the runtime's). */
const ART: Record<QualityTier, Omit<Look, "preset" | "budget" | "shadows" | "ao" | "bloom" | "grade" | "antialias">> = {
  low: { reflections: false, detailed: false, particles: "low", backdrop: "off" },
  balanced: { reflections: true, detailed: true, particles: "high", backdrop: "static" },
  high: { reflections: true, detailed: true, particles: "high", backdrop: "animated" },
  ultra: { reflections: true, detailed: true, particles: "high", backdrop: "animated" },
};
/** gfx.js BUDGETS. */
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", seg: 0.6, particles: 800, motes: 60 },
  balanced: { material: "standard", seg: 0.8, particles: 2000, motes: 100 },
  high: { material: "physical", seg: 1, particles: 4000, motes: 140 },
  ultra: { material: "physical", seg: 1.5, particles: 5000, motes: 220 },
};
export const PARTICLE_MAX = 7500;
export const MOTE_MAX = 330;
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };
const PARTICLE_SHARE = { low: 0.25, high: 1 };

/** The look for a level's settings. */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = { ...BUDGETS[preset] };
  const k = Math.min(1.5, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.particles = Math.min(PARTICLE_MAX, Math.round(b.particles * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: b,
  };
}
/** gfx.js particleCap: the live spark pool. */
export function particleCap(l: Look): number { return Math.round(l.budget.particles * PARTICLE_SHARE[l.particles]); }
