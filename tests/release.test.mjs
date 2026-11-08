import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parse} from 'yaml';

test('CI validates changes and deployment requires a tested build',async()=>{
 const ci=parse(await readFile('.github/workflows/ci.yml','utf8'));
 const deploy=parse(await readFile('.github/workflows/deploy.yml','utf8'));
 assert.ok(Object.hasOwn(ci.on,'pull_request'));
 assert.equal(ci.permissions.contents,'read');
 assert.ok(JSON.stringify(ci.jobs).includes('npm test'));
 assert.ok(JSON.stringify(ci.jobs).includes('verify:build'));
 assert.equal(deploy.jobs.deploy.needs,'build');
 assert.equal(deploy.jobs.deploy.permissions['pages'],'write');
 assert.ok(JSON.stringify(deploy.jobs.build).includes('npm test'));
 assert.ok(deploy.jobs.build.if.includes('refs/heads/main'));
 for(const workflow of [ci,deploy])for(const job of Object.values(workflow.jobs)){
  assert.ok(job['timeout-minutes']>0);
  for(const step of job.steps)if(step.uses)assert.match(step.uses,/@[a-f0-9]{40}$/);
 }
});

test('rendered pages use optimized previews while preserving original downloads',async()=>{
 const home=await readFile('dist/es-pe/index.html','utf8');
 const mascot=await readFile('dist/es-pe/mascot/index.html','utf8');
 const branding=await readFile('dist/es-pe/branding/index.html','utf8');
 assert.ok(home.includes('ukuku-peek-atlas.webp'));
 assert.ok(home.includes('platform-stack-light.webp'));
 assert.ok(mascot.includes('ukuku-seated-slide-rim.webp'));
 assert.match(branding,/src="[^"]*brand\/applications\/ukuku-plush\.webp"/);
 assert.match(branding,/href="[^"]*brand\/applications\/ukuku-plush\.png"[^>]*download/);
});
