/** Ruta a un archivo de `public/` respetando el `base` de GitHub Pages. */
export function asset(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/+$/, '');
  return `${base}/${path.replace(/^\/+/, '')}`;
}
