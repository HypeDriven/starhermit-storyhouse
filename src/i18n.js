// i18n.js: T and hasKey for src/loc.js. The engine client installs the engine's
// strings (native/i18n.ts); node tools get the English text, the keys.
let t = (key, vars) => (vars ? String(key).replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m)) : String(key));
let has = () => true;
export function useStrings(translate, known) { t = translate; has = known; }
export const T = (key, vars) => t(String(key), vars);
export const hasKey = (key) => has(String(key));
