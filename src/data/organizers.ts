import { publicRecords } from './public-content';
import type { Localized } from "@i18n/utils";
import { asset } from "@lib/assets";

export interface Organizer {
  name: string;
  shortName: string;
  figurine: string;
  color: string;
  role: string;
  company?: Localized;
  photo: string;
  /** Perfil público (LinkedIn). */
  url: string;
  links?: { label: string; href: string }[];
}

/** Equipo del capítulo. Ilustraciones basadas en los sprites proporcionados por el usuario. */
export const organizers: Organizer[] = publicRecords('organizers').map(r=>({name:r.name,shortName:r.shortName,figurine:asset(r.figurine),color:r.color,role:r.role['es-pe'],company:r.company,photo:asset(r.photo),url:r.url,...(r.links.length?{links:r.links}:{})}));
