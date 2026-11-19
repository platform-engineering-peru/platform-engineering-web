import type { Localized } from '@i18n/utils';
import { publicRecords } from './public-content';

export type ResourceType = 'guide' | 'article' | 'course' | 'report' | 'tool';
export type Topic = 'fundamentals' | 'idp' | 'golden-paths' | 'devex' | 'teams' | 'ai' | 'career';

export interface Resource {
  type: ResourceType;
  topic: Topic;
  title: Localized;
  description: Localized;
  href: string;
  /** Idioma del contenido enlazado. */
  contentLang: 'es' | 'en';
  coverArtKey?: string;
}

export const topics: { id: Topic; label: Localized }[] = [
  { id: 'fundamentals', label: { 'es-pe': 'Fundamentos', en: 'Fundamentals' } },
  { id: 'idp', label: { 'es-pe': 'IDP', en: 'IDP' } },
  { id: 'golden-paths', label: { 'es-pe': 'Golden paths', en: 'Golden paths' } },
  { id: 'devex', label: { 'es-pe': 'DevEx y métricas', en: 'DevEx & metrics' } },
  { id: 'teams', label: { 'es-pe': 'Equipos', en: 'Teams' } },
  { id: 'ai', label: { 'es-pe': 'IA', en: 'AI' } },
  { id: 'career', label: { 'es-pe': 'Carrera', en: 'Career' } },
];

/** Public resources and courses share editorial ordering and explicit artwork identity. */
export const resources: Resource[] = [...publicRecords('resources'),...publicRecords('courses')].sort((a,b)=>a.displayOrder-b.displayOrder).map(r=>({type:r.type,topic:r.topic,title:r.title,description:r.description,href:r.href,contentLang:r.contentLang,coverArtKey:r.coverArtKey}));
