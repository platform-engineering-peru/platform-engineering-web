/**
 * Enlaces de la comunidad en un solo lugar.
 *
 * TODO(comunidad): reemplazar los enlaces marcados como `null` por los reales antes de
 * publicar. Mientras un enlace sea `null`, el sitio lo muestra deshabilitado en lugar
 * de apuntar a un sitio falso.
 */
/** Correo de contacto del capítulo. */
export const contactEmail = 'info@platformengineering.pe';

export const communityLinks = {
  whatsapp: null as string | null,
  meetup: null as string | null,
  linkedin: 'https://www.linkedin.com/company/platformengineeringperu' as string | null,
  youtube: null as string | null,
  /** Call for speakers (Sessionize), abierto todo el año. */
  cfp: 'https://sessionize.com/platform-engineering-peru' as string | null,
  /** Contacto para sedes y sponsors. */
  sponsor: `mailto:${contactEmail}` as string | null,
};

/** Recursos de la comunidad global (platformengineering.org), verificados. */
export const globalLinks = {
  home: 'https://platformengineering.org/',
  whatIs: 'https://platformengineering.org/blog/what-is-platform-engineering',
  blog: 'https://platformengineering.org/blog',
  tooling: 'https://platformengineering.org/platform-tooling',
  reports: 'https://platformengineering.org/reports',
  university: 'https://university.platformengineering.org/',
  introCourse: 'https://university.platformengineering.org/introduction-to-platform-engineering',
  platformcon: 'https://platformcon.com/',
  platformWeekly: 'https://platformweekly.com/',
};
