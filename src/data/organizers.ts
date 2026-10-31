import type { Localized } from '@i18n/utils';
import { asset } from '@lib/assets';

export interface Organizer {
  name: string;
  role: string;
  company?: Localized;
  photo: string;
  /** Perfil público (LinkedIn). */
  url: string;
}

const same = (text: string): Localized => ({ 'es-pe': text, en: text });

/** Equipo organizador del capítulo; cargo, empresa y foto tomados de LinkedIn (oct. 2026). */
export const organizers: Organizer[] = [
  {
    name: 'Josua Castro',
    role: 'Platform Engineer - Golden Kubestronaut - KCD Lima Organizer',
    company: same('Banco de Crédito del Perú'),
    photo: asset('team/josua-castro.jpg'),
    url: 'https://www.linkedin.com/in/josuacvga/',
  },
  {
    name: 'Ronald Requena',
    role: 'CTO - CNCF Ambassador',
    company: same('Rumbo'),
    photo: asset('team/ronald-requena.jpg'),
    url: 'https://www.linkedin.com/in/rcronald/',
  },
];
