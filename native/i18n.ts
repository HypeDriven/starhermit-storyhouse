// Localization: the browser build's tables (src/strings.js and
// src/strings-content.js, English text as the keys, the nine StarHermit
// locales; the account strings in src/sh-i18n.js; content names through
// src/loc.js) in the interface language the runtime reports
// (preferences().language: the player's choice in Options › Language, else
// the account's preferred language or the device's). The runtime's Options
// replace the game's own Language setting (sh-language.js) and the DOM
// re-labelling: every string is drawn through T() each frame, so a change
// shows on the next frame and never restarts the story.
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { T as tr, setLang } from "../src/i18n.js";
import { shText } from "../src/sh-i18n.js";

let locale = "";
function apply(tag: string): void {
  const next = setLang(String(tag || "en-US")) as string;
  if (next === locale) return;
  locale = next;
  ui.setLanguage(locale);
}
apply(preferences().language);
onPreferencesChange((p) => apply(p.language));

export function currentLocale(): string { return locale; }
export type Vars = Record<string, string | number>;
/** An English source string in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string { return tr(key, vars ?? undefined) as string; }
/** Marks an English key that is translated with T() where it is shown. */
export const N = (s: string): string => s;
/** The account strings (signIn, invite, copied, copyFail, signedOut, lbPosting, lbRank, lbPosted, lbNotPosted). */
export function S(key: string, vars?: Vars): string { return shText(key, vars ?? {}) as string; }
