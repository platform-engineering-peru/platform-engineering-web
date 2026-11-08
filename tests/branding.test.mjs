import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {Window} from 'happy-dom';
test('brand library exposes working downloads in both languages',async()=>{
 for(const lang of ['es-pe','en']){
  const window=new Window({settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true}});
  window.document.write(await readFile(`dist/${lang}/branding/index.html`,'utf8'));
  const links=[...window.document.querySelectorAll('.brand-library a[download]')];
  assert.ok(links.length>=12);
  for(const link of links)await access('public'+decodeURI(new URL(link.href,'http://localhost').pathname));
  for(const id of ['logos','ukuku','palette','social','guidelines'])assert.ok(window.document.getElementById(id));
  assert.ok(window.document.querySelector(`footer a[href="/${lang}/branding/"]`));
  assert.equal(window.document.querySelector(`.mega-panel a[href="/${lang}/branding/"]`),null);
  assert.equal(window.document.querySelectorAll(".brand-logo-grid .brand-asset").length,2);
  await window.happyDOM.abort();
 }
});
