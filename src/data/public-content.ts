import Ajv from 'ajv';
import addFormats from 'ajv-formats';
const raw=import.meta.glob('../../content/**/*.json',{eager:true,import:'default'});
const schemas=import.meta.glob('../../content/schemas/*-v1.schema.json',{eager:true,import:'default'});
const ajv=new Ajv({allErrors:true,strict:false});addFormats(ajv);
export interface PublicRecord {schemaVersion:1;id:string;slug:string;status:'published'|'archived';updatedAt:string|null;displayOrder:number;[key:string]:any}
/** Build-time public boundary. Content is JSON only; adapters retain the approved renderers. */
export function publicRecords(type:string):PublicRecord[]{
 const schema=schemas[`../../content/schemas/${type}-v1.schema.json`];if(!schema)throw new Error(`Missing public schema: ${type}`);
 const validate=ajv.compile(schema as object),ids=new Set<string>(),slugs=new Set<string>(),orders=new Set<number>();
 return Object.entries(raw).filter(([p])=>p.startsWith(`../../content/${type}/`)).map(([path,input])=>{
 if(!validate(input))throw new Error(`Invalid ${path}: ${ajv.errorsText(validate.errors)}`);
 const record=input as PublicRecord;
 if(!path.endsWith(`/${record.id}.json`)||ids.has(record.id)||slugs.has(record.slug)||orders.has(record.displayOrder))throw new Error(`Duplicate identity, slug or ordering in ${path}`);
 ids.add(record.id);slugs.add(record.slug);orders.add(record.displayOrder);
 for(const key of ['title','description'])if(record[key]&&(!record[key]['es-pe']?.trim()||!record[key].en?.trim()))throw new Error(`Missing bilingual ${key}: ${path}`);
 return record;
 }).filter(r=>r.status==='published').sort((a,b)=>a.displayOrder-b.displayOrder);
}
