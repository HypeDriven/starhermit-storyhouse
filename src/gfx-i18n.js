// gfx-i18n.js — strings for the Graphics settings panel in every supported
// locale. The rest of the game is English-only; the panel picks its locale
// from navigator.language (exact tag, then language, then en-US).

const en = {
  quality: 'Quality', auto: 'Auto (detected: {tier})', renderScale: 'Render scale',
  fromPreset: 'From preset ({tier})', adaptive: 'Adaptive resolution', showFps: 'Show frame rate',
  postFailed: 'Post-processing is unavailable on this device, so the house is drawn without it.',
  unknownGpu: 'unknown GPU', effects: 'Effects',
  presets: { low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra' },
  cats: {
    shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Colour grade',
    antialias: 'Anti-aliasing', reflections: 'Reflections', detail: 'Room detail',
    particles: 'Particles', backdrop: 'Menu backdrop',
  },
  tiers: {
    off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    plain: 'Plain', detailed: 'Detailed', static: 'Still', animated: 'Animated',
  },
  sum: { shadows: '{n}² shadows', noShadows: 'no shadows', ao: 'ambient occlusion', aoHigh: 'full ambient occlusion', bloom: 'bloom', reflections: 'reflections', noAa: 'no anti-aliasing' },
};

const enUS = { ...en, cats: { ...en.cats, grade: 'Color grade' } };

const es = {
  quality: 'Calidad', auto: 'Automática (detectada: {tier})', renderScale: 'Escala de renderizado',
  fromPreset: 'Según el ajuste ({tier})', adaptive: 'Resolución adaptativa', showFps: 'Mostrar fotogramas por segundo',
  postFailed: 'El posprocesado no está disponible en este dispositivo; la casa se dibuja sin él.',
  unknownGpu: 'GPU desconocida', effects: 'Efectos',
  presets: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
  cats: {
    shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color',
    antialias: 'Suavizado de bordes', reflections: 'Reflejos', detail: 'Detalle de las habitaciones',
    particles: 'Partículas', backdrop: 'Fondo del menú',
  },
  tiers: {
    off: 'Desactivado', on: 'Activado', low: 'Bajo', medium: 'Medio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    plain: 'Sencillo', detailed: 'Detallado', static: 'Fijo', animated: 'Animado',
  },
  sum: { shadows: 'sombras {n}²', noShadows: 'sin sombras', ao: 'oclusión ambiental', aoHigh: 'oclusión ambiental completa', bloom: 'resplandor', reflections: 'reflejos', noAa: 'sin suavizado' },
};
const es419 = { ...es, cats: { ...es.cats, antialias: 'Antialiasing' }, sum: { ...es.sum, noAa: 'sin antialiasing' } };

const de = {
  quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})', renderScale: 'Renderskalierung',
  fromPreset: 'Aus Voreinstellung ({tier})', adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen',
  postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; das Haus wird ohne sie gezeichnet.',
  unknownGpu: 'unbekannte GPU', effects: 'Effekte',
  presets: { low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra' },
  cats: {
    shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Bloom', grade: 'Farbkorrektur',
    antialias: 'Kantenglättung', reflections: 'Reflexionen', detail: 'Raumdetails',
    particles: 'Partikel', backdrop: 'Menühintergrund',
  },
  tiers: {
    off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    plain: 'Schlicht', detailed: 'Detailliert', static: 'Still', animated: 'Animiert',
  },
  sum: { shadows: '{n}²-Schatten', noShadows: 'keine Schatten', ao: 'Umgebungsverdeckung', aoHigh: 'volle Umgebungsverdeckung', bloom: 'Bloom', reflections: 'Reflexionen', noAa: 'keine Kantenglättung' },
};

const fr = {
  quality: 'Qualité', auto: 'Automatique (détectée : {tier})', renderScale: 'Échelle de rendu',
  fromPreset: 'Selon le préréglage ({tier})', adaptive: 'Résolution adaptative', showFps: 'Afficher les images par seconde',
  postFailed: 'Le post-traitement n’est pas disponible sur cet appareil ; la maison est dessinée sans lui.',
  unknownGpu: 'GPU inconnu', effects: 'Effets',
  presets: { low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra' },
  cats: {
    shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Étalonnage des couleurs',
    antialias: 'Anticrénelage', reflections: 'Reflets', detail: 'Détail des pièces',
    particles: 'Particules', backdrop: 'Décor du menu',
  },
  tiers: {
    off: 'Désactivé', on: 'Activé', low: 'Bas', medium: 'Moyen', high: 'Élevé', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    plain: 'Simple', detailed: 'Détaillé', static: 'Fixe', animated: 'Animé',
  },
  sum: { shadows: 'ombres {n}²', noShadows: 'sans ombres', ao: 'occlusion ambiante', aoHigh: 'occlusion ambiante complète', bloom: 'halo', reflections: 'reflets', noAa: 'sans anticrénelage' },
};
const frCA = { ...fr, cats: { ...fr.cats, antialias: 'Antialiasage' }, sum: { ...fr.sum, noAa: 'sans antialiasage' } };

const pt = {
  quality: 'Qualidade', auto: 'Automática (detectada: {tier})', renderScale: 'Escala de renderização',
  fromPreset: 'Do predefinido ({tier})', adaptive: 'Resolução adaptativa', showFps: 'Mostrar taxa de quadros',
  postFailed: 'O pós-processamento não está disponível neste dispositivo; a casa é desenhada sem ele.',
  unknownGpu: 'GPU desconhecida', effects: 'Efeitos',
  presets: { low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
  cats: {
    shadows: 'Sombras', ao: 'Oclusão de ambiente', bloom: 'Brilho', grade: 'Correção de cor',
    antialias: 'Antisserrilhado', reflections: 'Reflexos', detail: 'Detalhe dos cômodos',
    particles: 'Partículas', backdrop: 'Fundo do menu',
  },
  tiers: {
    off: 'Desligado', on: 'Ligado', low: 'Baixo', medium: 'Médio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    plain: 'Simples', detailed: 'Detalhado', static: 'Parado', animated: 'Animado',
  },
  sum: { shadows: 'sombras {n}²', noShadows: 'sem sombras', ao: 'oclusão de ambiente', aoHigh: 'oclusão de ambiente completa', bloom: 'brilho', reflections: 'reflexos', noAa: 'sem antisserrilhado' },
};

const it = {
  quality: 'Qualità', auto: 'Automatica (rilevata: {tier})', renderScale: 'Scala di rendering',
  fromPreset: 'Dal preset ({tier})', adaptive: 'Risoluzione adattiva', showFps: 'Mostra frame rate',
  postFailed: 'La post-elaborazione non è disponibile su questo dispositivo; la casa viene disegnata senza.',
  unknownGpu: 'GPU sconosciuta', effects: 'Effetti',
  presets: { low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra' },
  cats: {
    shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore',
    antialias: 'Antialiasing', reflections: 'Riflessi', detail: 'Dettaglio delle stanze',
    particles: 'Particelle', backdrop: 'Sfondo del menu',
  },
  tiers: {
    off: 'No', on: 'Sì', low: 'Basso', medium: 'Medio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    plain: 'Semplice', detailed: 'Dettagliato', static: 'Fisso', animated: 'Animato',
  },
  sum: { shadows: 'ombre {n}²', noShadows: 'nessuna ombra', ao: 'occlusione ambientale', aoHigh: 'occlusione ambientale completa', bloom: 'bagliore', reflections: 'riflessi', noAa: 'nessun antialiasing' },
};

export const GFX_STRINGS = {
  'en-US': enUS, 'en-GB': en, 'es-419': es419, 'es-ES': es, 'de-DE': de,
  'fr-FR': fr, 'fr-CA': frCA, 'pt-BR': pt, 'it-IT': it,
};
const BY_LANG = { en: 'en-US', es: 'es-419', de: 'de-DE', fr: 'fr-FR', pt: 'pt-BR', it: 'it-IT' };

/** Pick the closest supported locale for a BCP-47 tag. */
export function gfxLocale(tag) {
  const t = String(tag || 'en-US');
  const exact = Object.keys(GFX_STRINGS).find(k => k.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const lang = t.split('-')[0].toLowerCase();
  if (lang === 'es' && /-es$/i.test(t)) return 'es-ES';
  if (lang === 'en' && /-(gb|ie|au|nz|za|in)$/i.test(t)) return 'en-GB';
  if (lang === 'fr' && /-ca$/i.test(t)) return 'fr-CA';
  return BY_LANG[lang] || 'en-US';
}

export function gfxStrings(tag) {
  return GFX_STRINGS[gfxLocale(tag)];
}

export function fmt(s, vars) {
  return String(s).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
}
