import { publicRecords } from './public-content';
import { pick, type Localized } from '@i18n/utils';
import type { Lang } from '@i18n/config';
import { asset } from '@lib/assets';

export interface Speaker {
  name: string;
  role?: string;
  company?: Localized;
  talk?: Localized;
  photo?: string;
  /** Perfil público (LinkedIn…). */
  url?: string;
}

/** Speakers de los eventos; `events.ts` los referencia por `name`. */
const speakerRecords=publicRecords('speakers');
export const speakerIdentity=new Map(speakerRecords.map(r=>[r.id,r.name as string]));
const populated=(value:Localized):Localized|undefined=>value['es-pe']||value.en?value:undefined;
export const speakers: Speaker[] = speakerRecords.map(r=>({name:r.name,role:r.role['es-pe']||undefined,company:populated(r.company),talk:populated(r.talk),photo:r.photo?(/^https:\/\//.test(r.photo)?r.photo:asset(r.photo)):undefined,url:r.url||undefined}));

export function speakersByName(names: string[]): Speaker[] {
  return names.map((n) => speakers.find((s) => s.name === n)).filter((s): s is Speaker => !!s);
}

/** Props de `SpeakerCard` en el idioma dado. */
export function speakerProps(s: Speaker, lang: Lang) {
  return {
    name: s.name,
    role: s.role,
    company: s.company && pick(s.company, lang),
    talk: s.talk && pick(s.talk, lang),
    photo: s.photo,
    url: s.url,
  };
}
