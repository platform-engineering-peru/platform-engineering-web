import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import eventsSchema from '../../content/schemas/events-v1.schema.json';
import speakersSchema from '../../content/schemas/speakers-v1.schema.json';
import organizersSchema from '../../content/schemas/organizers-v1.schema.json';
import resourcesSchema from '../../content/schemas/resources-v1.schema.json';
import coursesSchema from '../../content/schemas/courses-v1.schema.json';
import settingsSchema from '../../content/schemas/settings-v1.schema.json';
import brandsSchema from '../../content/schemas/brands-v1.schema.json';

const schemas = {events:eventsSchema,speakers:speakersSchema,organizers:organizersSchema,resources:resourcesSchema,courses:coursesSchema,settings:settingsSchema,brands:brandsSchema};
export type PublicType = keyof typeof schemas;
export interface PublicRecord {
  schemaVersion: 1;
  id: string;
  slug: string;
  status: 'published' | 'archived';
  updatedAt: string | null;
  displayOrder: number;
  [key: string]: any;
}
export type PublicCollections = Record<PublicType, PublicRecord[]>;
const ajv = new Ajv({allErrors:true,strict:false});
addFormats(ajv);
const validators = Object.fromEntries(Object.entries(schemas).map(([type,schema])=>[type,ajv.compile(schema)]));

/** Validate the whole public snapshot, including references and shared listing identities. */
export function validatePublicContent(input: Record<PublicType, unknown[]>): PublicCollections {
  const result = {} as PublicCollections;
  for (const type of Object.keys(schemas) as PublicType[]) {
    const ids = new Set<string>(), slugs = new Set<string>(), orders = new Set<number>();
    result[type] = input[type].map(value=>{
      const validate=validators[type];
      if (!validate(value)) throw new Error(`Invalid public ${type}: ${ajv.errorsText(validate.errors)}`);
      const record=value as PublicRecord;
      if (ids.has(record.id)||slugs.has(record.slug)||orders.has(record.displayOrder)) throw new Error(`Duplicate identity, slug or ordering in ${type}: ${record.id}`);
      ids.add(record.id);slugs.add(record.slug);orders.add(record.displayOrder);
      for (const key of ['title','description']) if (record[key] && (!record[key]['es-pe']?.trim()||!record[key].en?.trim())) throw new Error(`Missing bilingual ${key} in ${type}: ${record.id}`);
      return record;
    }).sort((a,b)=>a.displayOrder-b.displayOrder);
  }
  if (result.settings.length!==1||result.settings[0].status!=='published') throw new Error('Exactly one published public settings record is required');
  const resources=[...result.resources,...result.courses];
  if (new Set(resources.map(r=>r.slug)).size!==resources.length||new Set(resources.map(r=>r.displayOrder)).size!==resources.length) throw new Error('Resources and courses require distinct shared slugs and ordering');
  const speakers=new Map(result.speakers.map(r=>[r.id,r]));
  for (const event of result.events) for (const id of event.speakerIds as string[]) {
    const speaker=speakers.get(id);
    if (!speaker||(event.status==='published'&&speaker.status!=='published')) throw new Error(`Unknown or unpublished public speaker ${id} in event ${event.id}`);
  }
  return result;
}

let snapshot: PublicCollections | undefined;
/** JSON is the sole content source; empty and archived collections never revive old arrays. */
export function publicRecords(type: PublicType): PublicRecord[] {
  if (!snapshot) {
    const files=import.meta.glob('../../content/**/*.json',{eager:true,import:'default'});
    const input: Record<PublicType,unknown[]>={events:[],speakers:[],organizers:[],resources:[],courses:[],settings:[],brands:[]};
    for (const [path,value] of Object.entries(files)) {
      const match=path.match(/^\.\.\/\.\.\/content\/([^/]+)\/([^/]+)\.json$/);
      if (!match||!(match[1] in schemas)) continue;
      const record=value as PublicRecord;
      if (record?.id!==match[2]) throw new Error(`Public filename must match immutable UUID: ${path}`);
      input[match[1] as PublicType].push(value);
    }
    snapshot=validatePublicContent(input);
  }
  return snapshot[type].filter(record=>record.status==='published');
}
