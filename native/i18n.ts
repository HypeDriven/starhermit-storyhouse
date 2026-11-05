// Localization: the browser build's tables (English text as the keys, the nine
// StarHermit locales; en-GB, es-ES and fr-CA list only their differences; content
// names through src/loc.js) in assets/strings.json, on the engine's strings: the
// interface language the runtime reports (the player's choice in Options ›
// Language, else the account's preferred language or the device's), its locale
// chain, and the account lines the engine keeps (`starhermit.*`). Every string
// is drawn through T() each frame, so a change shows on the next frame and never
// restarts the story.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { useStrings } from "../src/i18n.js";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

export type Vars = Record<string, string | number>;
/** An English source string in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string { return strings.t(key, vars ?? undefined); }
/** Marks an English key that is translated with T() where it is shown. */
export const N = (s: string): string => s;
useStrings((key: string, vars?: Vars) => strings.t(key, vars), (key: string) => strings.has(key)); // src/loc.js
/** The engine's account strings (signIn, invite, inviteCopied, inviteLink, signedOut, leaderboardPosting, leaderboardRank, leaderboardPosted, leaderboardNotPosted). */
export function S(key: string, vars?: Vars): string { return strings.t(`starhermit.${key}`, vars); }
