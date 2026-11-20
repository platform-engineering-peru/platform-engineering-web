import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
const baseline=JSON.parse(readFileSync(new URL('./fixtures/public-content-baseline.json',import.meta.url)));
const records=type=>readdirSync(new URL(`../content/${type}/`,import.meta.url)).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(readFileSync(new URL(`../content/${type}/${n}`,import.meta.url)))).sort((a,b)=>a.displayOrder-b.displayOrder);
const clean=value=>JSON.parse(JSON.stringify(value));
test('organizer identity retains the exact original name, photo, figurine, links and order',()=>{assert.deepEqual(records('organizers').map(r=>clean({name:r.name,shortName:r.shortName,figurine:r.figurine,color:r.color,role:r.role['es-pe'],company:r.company,photo:r.photo,url:r.url,...r.links.length?{links:r.links}:{}})),baseline.organizers);});
test('original resources preserve bilingual content, relative order and artwork while additions remain allowed',()=>{
  const originalIds = [
    '94b65609-2a54-83ff-a900-b596d1c4acda', '77924b1c-e25e-86fb-8113-8d47411469e1',
    '3b31ef3c-1b82-88d8-953a-29cfbfbe159a', 'f3e585b3-5142-838d-8bdf-851d6e7fe70e',
    '91691382-2950-84f2-85db-3729b773e372', '7eaa27b2-cada-8fed-807e-891d012e5a48',
    '0099af26-6b0d-8ac5-90be-83597dad5b8e', 'b8006ac2-280f-88c6-9f8c-16bb32efa207',
    '22c8c3fd-644a-854b-9d9e-7106fa1c3ca5', '32e387e2-4d8f-8083-b647-f7c4676528c4',
    '1d1be259-fa43-864b-9888-ddfe98c1ee66', 'dd90cc57-ad88-87be-9e56-e0b028bac7ac',
  ];
  const originals=[...records('resources'),...records('courses')]
    .sort((a,b)=>a.displayOrder-b.displayOrder).filter(r=>originalIds.includes(r.id));
  assert.deepEqual(originals.map(r=>r.id),originalIds);
  assert.deepEqual(originals.map(r=>({type:r.type,topic:r.topic,contentLang:r.contentLang,href:r.href,title:r.title,description:r.description})),baseline.resources);
  assert.deepEqual(originals.map(r=>r.coverArtKey),[
    'fundamentals:guide','fundamentals:course','idp:article','idp:cage',
    'golden-paths:article','devex:score','devex:article','teams:article',
    'ai:article','career:article','idp:tool','fundamentals:report',
  ]);
});
test('public speakers and UUID event references preserve the original rendering projection',()=>{const speakers=records('speakers'),byId=new Map(speakers.map(r=>[r.id,r.name]));const populated=v=>v['es-pe']||v.en?v:undefined;assert.deepEqual(speakers.map(r=>clean({name:r.name,role:r.role['es-pe']||undefined,company:populated(r.company),talk:populated(r.talk),photo:r.photo||undefined,url:r.url||undefined})),baseline.speakers);assert.deepEqual(records('events').map(r=>clean({slug:r.slug,date:r.date,time:r.time,endTime:r.endTime||undefined,city:r.city,venue:r.venue,address:r.address||undefined,online:r.online||undefined,status:r.eventStatus,organizer:r.organizer||undefined,registerUrl:r.registerUrl||undefined,title:r.title,description:r.description,speakers:r.speakerIds.map(id=>{assert.ok(byId.has(id));return byId.get(id)}),recording:r.recording||undefined})),baseline.events);});
test('site settings keep intentional null channels and official links exactly',()=>{const r=records('settings')[0];assert.deepEqual({contactEmail:r.contactEmail,communityLinks:r.communityLinks,globalLinks:r.globalLinks},baseline.site);});
test('every migrated public entity validates strict schema; settings reject active/private link schemes',()=>{const ajv=new Ajv({allErrors:true,strict:false});addFormats(ajv);for(const type of ['resources','courses','organizers','speakers','events','settings','brands']){const schema=JSON.parse(readFileSync(new URL(`../content/schemas/${type}-v1.schema.json`,import.meta.url))),validate=ajv.compile(schema);for(const r of records(type))assert.equal(validate(r),true,`${type} ${ajv.errorsText(validate.errors)}`);const bad={...records(type)[0],privateNotes:'private'};assert.equal(validate(bad),false);if(type==='settings')for(const url of ['javascript:alert(1)','data:text/html,x','http://example.org','https://127.0.0.1/a','https://localhost/a']){const changed=structuredClone(records(type)[0]);changed.communityLinks.linkedin=url;assert.equal(validate(changed),false,url);}}});
