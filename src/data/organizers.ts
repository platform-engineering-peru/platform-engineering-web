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

const same = (text: string): Localized => ({ "es-pe": text, en: text });

/** Equipo del capítulo. Ilustraciones basadas en los sprites proporcionados por el usuario. */
export const organizers: Organizer[] = [
  {
    name: "Josua Castro",
    shortName: "Josua",
    figurine: asset("team/josua-3d.webp"),
    color: "#c9d9bd",
    role: "Platform Engineer - Golden Kubestronaut - KCD Lima Organizer",
    company: same("Banco de Crédito del Perú"),
    photo: asset("team/josua-castro.jpg"),
    url: "https://www.linkedin.com/in/josuacvga/",
  },
  {
    name: "Oscar Lobaton Salas",
    shortName: "Oscar",
    figurine: asset("team/oscar-coffee.webp"),
    color: "#cec8e8",
    role: "SRE & FDE · DevOps Institute Ambassador · International Speaker",
    company: same("Cobre"),
    photo: asset("team/oscar-coffee.webp"),
    url: "https://www.linkedin.com/in/oscarlobatons/",
    links: [
      { label: "0vas.com", href: "https://0vas.com" },
      { label: "GitHub", href: "https://github.com/0vas" },
    ],
  },
  {
    name: "Ronald Requena",
    shortName: "Ronald",
    figurine: asset("team/ronald-3d.webp"),
    color: "#e5c6b3",
    role: "CTO - CNCF Ambassador",
    company: same("Rumbo"),
    photo: asset("team/ronald-requena.jpg"),
    url: "https://www.linkedin.com/in/rcronald/",
  },
];
