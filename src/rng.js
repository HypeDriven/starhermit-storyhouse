// rng.js — deterministic seeded random streams (pure, no DOM, no Node deps).
// Three independent stream roles per spec: rules, content decoration, audiovisual.
// Cosmetic randomness must never touch the rules stream.

/** mulberry32 — small fast seeded PRNG. State is a single uint32. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit hash of a string. Used for state hashes and seed derivation. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Derive a uint32 seed from any number of string/number parts. */
export function deriveSeed(...parts) {
  return fnv1a(parts.map(String).join('|'));
}

/**
 * A serializable random stream. The internal state is a plain uint32 so it can
 * live inside the rules state and round-trip through JSON unchanged.
 */
export class RngStream {
  constructor(seed) { this.state = seed >>> 0; }
  next() {
    let a = this.state;
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    this.state = a >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(lo, hi) { return lo + Math.floor(this.next() * (hi - lo + 1)); } // inclusive
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  fork(label) { return new RngStream(deriveSeed(this.state, label)); }
}

/** Canonical JSON with stable key order — the basis of every state hash. */
export function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}';
}

/** Deterministic 32-bit hash of any JSON-serializable value. */
export function hashValue(value) {
  return fnv1a(canonicalStringify(value)).toString(16).padStart(8, '0');
}
