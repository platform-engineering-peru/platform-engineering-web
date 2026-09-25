/**
 * Idiomas soportados. La clave es el segmento de la URL (`/es-pe/`, `/en/`);
 * `code` es la etiqueta BCP 47 usada en `<html lang>` y `hreflang`.
 */
export const languages = {
  'es-pe': { label: 'Español (Perú)', short: 'ES', code: 'es-PE' },
  en: { label: 'English', short: 'EN', code: 'en' },
} as const;

export type Lang = keyof typeof languages;

export const defaultLang: Lang = 'es-pe';

export const locales = Object.keys(languages) as Lang[];

/** Etiqueta BCP 47 del idioma (`es-PE`, `en`). */
export function langCode(lang: Lang): string {
  return languages[lang].code;
}
