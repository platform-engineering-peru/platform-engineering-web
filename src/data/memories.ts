import { asset } from '../lib/assets';
import type { Lang } from '../i18n/config';
import version from '../../content/schema-version.json';
import { projectMemories, validateMemories } from './memories-contract';

const files = import.meta.glob('../../content/memories/*.json', { eager: true, import: 'default' });
if (version.schemaVersion !== 1) throw new Error('Unsupported public content schema version');
for (const [path, record] of Object.entries(files)) {
  if (typeof record !== 'object' || record === null || !('id' in record) || path.split('/').pop() !== `${record.id}.json`) {
    throw new Error(`Memory filename must match its immutable UUID: ${path}`);
  }
}
const records = validateMemories(Object.values(files));
export function getMemoryPhotos(lang: Lang) {
  const photos = projectMemories(records, lang, asset);
  if (photos.length === 0) throw new Error('Memories requires at least one published photo');
  return photos;
}
