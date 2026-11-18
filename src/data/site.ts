import { publicRecords } from './public-content';
const settings=publicRecords('settings')[0];
if(!settings)throw new Error('Public site settings are required');
/** Curated JSON settings preserve intentional null channels and official public links. */
export const contactEmail:string=settings.contactEmail;
export const communityLinks=settings.communityLinks as {whatsapp:string|null;meetup:string|null;linkedin:string|null;youtube:string|null;cfp:string|null;sponsor:string|null};
export const globalLinks=settings.globalLinks as Record<'home'|'whatIs'|'blog'|'tooling'|'reports'|'university'|'introCourse'|'platformcon'|'platformWeekly',string>;
