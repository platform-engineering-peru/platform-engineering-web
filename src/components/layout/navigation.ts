import type { TranslationKey } from '@i18n/index';

export interface NavItem {
  path: string;
  label: TranslationKey;
}

/** Punto único para añadir/quitar páginas del menú. */
export const navigation: NavItem[] = [
  { path: '/', label: 'nav.home' },
  { path: '/events', label: 'nav.events' },
  { path: '/resources', label: 'nav.resources' },
  { path: '/community', label: 'nav.community' },
];
