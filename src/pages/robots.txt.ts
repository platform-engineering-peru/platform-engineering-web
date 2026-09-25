import type { APIRoute } from 'astro';

/**
 * robots.txt con la URL absoluta del sitemap (depende de SITE y BASE_PATH).
 * Nota: los buscadores solo leen /robots.txt en la raíz del dominio; en
 * `usuario.github.io/<repo>/` este archivo no se consulta, con dominio propio sí.
 */
export const GET: APIRoute = ({ site }) => {
  const base = import.meta.env.BASE_URL.replace(/\/+$/, '');
  const sitemap = new URL(`${base}/sitemap-index.xml`, site);
  const body = `User-agent: *\nAllow: /\n\nSitemap: ${sitemap.href}\n`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
