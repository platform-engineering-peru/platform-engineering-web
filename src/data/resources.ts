import type { Localized } from '@i18n/utils';
import { globalLinks } from './site';

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

const blog = (slug: string) => `${globalLinks.blog}/${slug}`;

/** Selección curada de la comunidad global, con resumen en español. */
export const resources: Resource[] = [
  {
    type: 'guide', topic: 'fundamentals', contentLang: 'en', href: globalLinks.whatIs,
    title: { 'es-pe': '¿Qué es platform engineering?', en: 'What is platform engineering?' },
    description: { 'es-pe': 'La definición, el porqué y cómo se relaciona con DevOps y SRE.', en: 'The definition, the why and how it relates to DevOps and SRE.' },
  },
  {
    type: 'course', topic: 'fundamentals', contentLang: 'en', href: globalLinks.introCourse,
    title: { 'es-pe': 'Curso gratuito: introducción a platform engineering', en: 'Free course: introduction to platform engineering' },
    description: { 'es-pe': 'El punto de partida recomendado de Platform Engineering University.', en: 'The recommended starting point from Platform Engineering University.' },
  },
  {
    type: 'article', topic: 'idp', contentLang: 'en', href: blog('what-is-a-minimum-viable-platform-mvp'),
    title: { 'es-pe': '¿Qué es una minimum viable platform?', en: 'What is a minimum viable platform?' },
    description: { 'es-pe': 'Cómo empezar una IDP pequeña que resuelva un problema real.', en: 'How to start a small IDP that solves a real problem.' },
  },
  {
    type: 'article', topic: 'idp', contentLang: 'en', href: blog('golden-cage-syndrome-why-internal-developer-platforms-fail'),
    title: { 'es-pe': 'Golden cage: por qué fallan las IDP', en: 'Golden cage syndrome: why IDPs fail' },
    description: { 'es-pe': 'Cuando la plataforma restringe en lugar de habilitar.', en: 'When the platform restricts instead of enabling.' },
  },
  {
    type: 'article', topic: 'golden-paths', contentLang: 'en', href: blog('building-your-golden-path-lessons-from-the-trenches'),
    title: { 'es-pe': 'Construye tu golden path: lecciones de campo', en: 'Building your golden path: lessons from the trenches' },
    description: { 'es-pe': 'Qué funciona al diseñar caminos dorados que los equipos adoptan.', en: 'What works when designing golden paths teams adopt.' },
  },
  {
    type: 'article', topic: 'devex', contentLang: 'en', href: blog('the-platform-scorecard-a-practical-way-to-provevalue-and-what-to-measure-first'),
    title: { 'es-pe': 'Platform scorecard: qué medir primero', en: 'The platform scorecard: what to measure first' },
    description: { 'es-pe': 'Una forma práctica de demostrar el valor de la plataforma.', en: 'A practical way to prove platform value.' },
  },
  {
    type: 'article', topic: 'devex', contentLang: 'en', href: blog('the-empathy-gap-why-your-platform-needs-ux-not-just-apis'),
    title: { 'es-pe': 'Tu plataforma necesita UX, no solo APIs', en: 'Your platform needs UX, not just APIs' },
    description: { 'es-pe': 'La brecha de empatía entre el equipo de plataforma y sus usuarios.', en: 'The empathy gap between platform teams and their users.' },
  },
  {
    type: 'article', topic: 'teams', contentLang: 'en', href: blog('how-to-build-your-platform-engineering-team'),
    title: { 'es-pe': 'Cómo armar tu equipo de plataforma', en: 'How to build your platform engineering team' },
    description: { 'es-pe': 'Roles, tamaño y cuándo dar el primer paso.', en: 'Roles, size and when to take the first step.' },
  },
  {
    type: 'article', topic: 'ai', contentLang: 'en', href: blog('ai-and-platform-engineering'),
    title: { 'es-pe': 'IA y platform engineering', en: 'AI and platform engineering' },
    description: { 'es-pe': 'Cómo cambia la plataforma interna con agentes y herramientas de IA.', en: 'How the internal platform changes with AI agents and tools.' },
  },
  {
    type: 'article', topic: 'career', contentLang: 'en', href: blog('job-interview-platform-engineering-role'),
    title: { 'es-pe': 'Prepárate para una entrevista de platform engineer', en: 'Preparing for a platform engineering interview' },
    description: { 'es-pe': 'Qué preguntan y cómo contar tu experiencia.', en: 'What they ask and how to present your experience.' },
  },
  {
    type: 'tool', topic: 'idp', contentLang: 'en', href: globalLinks.tooling,
    title: { 'es-pe': 'Landscape de herramientas de plataforma', en: 'Platform tooling landscape' },
    description: { 'es-pe': 'El ecosistema por capas y cómo combinar las piezas.', en: 'The ecosystem by layer and how to combine the pieces.' },
  },
  {
    type: 'report', topic: 'fundamentals', contentLang: 'en', href: globalLinks.reports,
    title: { 'es-pe': 'Reportes de la industria', en: 'Industry reports' },
    description: { 'es-pe': 'El estado de platform engineering con datos de miles de equipos.', en: 'The state of platform engineering with data from thousands of teams.' },
  },
];
