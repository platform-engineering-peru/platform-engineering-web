import { defaultLang, languages, type Lang } from './config';
import esPe from './locales/es-pe.json';
import en from './locales/en.json';

// `es-pe` es el diccionario de referencia: sus claves definen el contrato
// que deben cumplir los demás idiomas (lo valida el tipo `Record`).
export type TranslationKey = keyof typeof esPe;

const dictionaries: Record<Lang, Record<TranslationKey, string>> = { 'es-pe': esPe, en };

export function isLang(value: string | undefined): value is Lang {
  return !!value && value in languages;
}

/** Obtiene el idioma a partir del primer segmento de la URL (tras el base). */
export function getLangFromUrl(url: URL): Lang {
  const base = import.meta.env.BASE_URL;
  const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;
  const [segment] = path.replace(/^\/+/, '').split('/');
  return isLang(segment) ? segment : defaultLang;
}

/** Devuelve una función `t` para el idioma dado, con fallback al idioma por defecto. */
export function useTranslations(lang: Lang) {
  return function t(key: TranslationKey): string {
    return dictionaries[lang][key] ?? dictionaries[defaultLang][key] ?? key;
  };
}

/** Construye una ruta localizada respetando el `base` de GitHub Pages. */
export function localizePath(lang: Lang, path = '/'): string {
  const base = import.meta.env.BASE_URL.replace(/\/+$/, '');
  const clean = path.replace(/^\/+|\/+$/g, '');
  return `${base}/${lang}/${clean ? `${clean}/` : ''}`;
}

/** Traduce la URL actual a otro idioma conservando la página. */
export function switchLangPath(url: URL, target: Lang): string {
  const base = import.meta.env.BASE_URL;
  const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;
  const segments = path.replace(/^\/+/, '').split('/').filter(Boolean);
  // Páginas fuera de `[lang]` (p. ej. 404) no tienen equivalente: se va al inicio.
  if (!isLang(segments[0])) return localizePath(target);
  segments.shift();
  return localizePath(target, segments.join('/'));
}

/** Texto con una variante por idioma, para datos (eventos, recursos…). */
export type Localized<T = string> = Record<Lang, T>;

/** Resuelve un valor `Localized` al idioma actual. */
export function pick<T>(value: Localized<T>, lang: Lang): T {
  return value[lang] ?? value[defaultLang];
}
