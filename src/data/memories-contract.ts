import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import schema from '../../content/schemas/memory-v1.schema.json';
import legacy from '../../content/memories-legacy.json';
import type { Lang } from '../i18n/config';

export type LocalizedMemoryText = Record<Lang, string>;
export interface MemoryMedia {
  id: string;
  path: string;
  width: number;
  height: number;
  alt: LocalizedMemoryText;
  fit: 'contain' | 'cover';
  credit: string | null;
  focalPoint?: {x:number;y:number}|null;
}
export interface MemoryRecord {
  schemaVersion: 1;
  id: string;
  slug: string;
  status: 'published' | 'archived';
  title: LocalizedMemoryText;
  description: LocalizedMemoryText;
  eventId: string | null;
  capturedAt: string | null;
  captureYear: number | null;
  datePrecision: 'unknown' | 'year' | 'day';
  media: MemoryMedia[];
  tags: string[];
  displayOrder: number;
  updatedAt: string | null;
}
export interface MemoryPhoto {
  fit?: "cover";
  focalPoint?: {x:number;y:number};
  src: string;
  title: string;
  alt: string;
  description: string;
}
const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile<MemoryRecord>(schema);
function fail(path: string, message: string): never {
  throw new Error(`Invalid Memories content at ${path}: ${message}`);
}

/** Build-time boundary: schema validation runs before any record reaches the renderer. */
export function validateMemories(input: unknown, knownEventIds: ReadonlySet<string> = new Set()): MemoryRecord[] {
  if (!Array.isArray(input)) return fail('/', 'expected an array');
  const ids = new Set<string>(), slugs = new Set<string>(), orders = new Set<number>(), mediaIds = new Set<string>();
  for (const [index, value] of input.entries()) {
    const path = `/${index}`;
    if (!validate(value)) {
      const messages = validate.errors!.map(error => {
        const extra = error.keyword === 'additionalProperties' ? `/${error.params.additionalProperty}` :
          error.keyword === 'required' ? `/${error.params.missingProperty}` : '';
        return `${path}${error.instancePath}${extra}: ${error.message}`;
      });
      return fail(path, messages.join('; '));
    }
    const record = value;
    for (const [key, set, entry] of [['id', ids, record.id], ['slug', slugs, record.slug], ['displayOrder', orders, record.displayOrder]] as const) {
      if ((set as Set<string | number>).has(entry)) fail(`${path}/${key}`, 'duplicate value');
      (set as Set<string | number>).add(entry);
    }
    if (record.eventId !== null && !knownEventIds.has(record.eventId)) fail(`${path}/eventId`, 'unknown event reference');
    if (record.datePrecision === 'unknown' && (record.capturedAt !== null || record.captureYear !== null)) fail(`${path}/capturedAt`, 'unknown precision requires null date and year');
    if (record.datePrecision === 'year' && (record.capturedAt !== null || record.captureYear === null)) fail(`${path}/capturedAt`, 'year precision requires only captureYear');
    if (record.datePrecision === 'day' && (record.capturedAt === null || Number(record.capturedAt.slice(0,4)) !== record.captureYear)) fail(`${path}/capturedAt`, 'day precision requires matching date and year');
    if (record.updatedAt === null && !legacy.records.some(item => item.id === record.id)) fail(`${path}/updatedAt`, 'only migrated records may have an unknown editorial timestamp');
    for (const [i, media] of record.media.entries()) {
      const mediaPath = `${path}/media/${i}`;
      if (mediaIds.has(media.id)) fail(`${mediaPath}/id`, 'duplicate media identity');
      mediaIds.add(media.id);
      if (media.path.startsWith('memories/')) {
        const original = legacy.records.find(item => item.id === record.id && item.mediaId === media.id && item.path === media.path);
        if (!original) fail(`${mediaPath}/path`, 'unapproved legacy media reference');
        if (media.width !== original.width) fail(`${mediaPath}/width`, 'does not match original dimensions');
        if (media.height !== original.height) fail(`${mediaPath}/height`, 'does not match original dimensions');
      }
      if (!existsSync(resolve('public', media.path))) fail(`${mediaPath}/path`, 'public asset does not exist');
    }
  }
  return [...input].sort((a,b) => a.displayOrder - b.displayOrder);
}

/** Keep content identity separate from the positional hooks used by the ribbon. */
export function projectMemories(records: readonly MemoryRecord[], lang: Lang, asset: (path: string) => string): MemoryPhoto[] {
  return records.filter(record => record.status === 'published').flatMap(record =>
    record.media.map(media => ({ src: asset(media.path), title: record.title[lang], alt: media.alt[lang], description: record.description[lang], ...(media.fit==='cover'?{fit:"cover" as const,...media.focalPoint?{focalPoint:media.focalPoint}:{}}:{}) })),
  );
}
