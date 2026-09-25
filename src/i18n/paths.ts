import { locales } from './config';

/** Genera una ruta estática por idioma; reutilizado por todas las páginas `[lang]`. */
export function getLangPaths() {
  return locales.map((lang) => ({ params: { lang } }));
}
