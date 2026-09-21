import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createServer} from 'node:http';
import {resolve,sep} from 'node:path';
import {chromium} from 'playwright';
const evidence=process.env.SPIKE_EVIDENCE||'.planning/phases/01-editor-and-responsive-design-proof/evidence';
for(const candidate of ['native','gridstack','rgl'])test(`${candidate} independent production build executes`,async()=>{
 const root=resolve('dist',candidate),errors=[];
 const server=createServer((req,res)=>{try{const path=resolve(root,'.'+new URL(req.url,'http://localhost').pathname.replace(/\/$/,'/index.html'));if(!path.startsWith(root+sep))throw Error();res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(readFileSync(path));}catch{res.statusCode=404;res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();
 try{const page=await browser.newPage({viewport:{width:1920,height:1080}});page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByRole('button',{name:'Edit layout',exact:true}).click();await page.getByRole('button',{name:'Move down',exact:true}).click();const s=await page.evaluate(()=>window.spike.candidateSnapshot());assert.equal(s.candidate,candidate);assert.equal(s.resolved.items[0].y,1);assert.deepEqual(errors,[]);await page.screenshot({path:`${evidence}/build-${candidate}.png`});if(candidate==='native'){const opened=page.waitForEvent('popup');await page.getByRole('button',{name:'Open separate preview',exact:true}).click();const preview=await opened;await preview.getByRole('heading',{name:'Screen preview',exact:true}).waitFor();assert.deepEqual((await preview.evaluate(()=>window.spike.candidateSnapshot())).doc,s.doc);assert.equal(await preview.locator('.handle,.resize-handle,#edit').count(),0);await preview.screenshot({path:`${evidence}/build-native-preview.png`});await preview.close();}}finally{await browser.close();await new Promise(r=>server.close(r));}
});
const rows=JSON.parse(readFileSync(`${evidence}/bundles.json`,'utf8'));
test('independent candidate builds exclude losing engines and have different runtime costs',()=>{
 assert.equal(rows.length,3);assert.equal(new Set(rows.map(r=>r.jsBytes)).size,3,'all candidate builds contain the same engines');
 for(const row of rows){const names=readdirSync(`dist/${row.candidate}/assets`).join(' ');for(const other of ['native','gridstack','rgl'].filter(x=>x!==row.candidate))assert.ok(!names.includes(other+'-'),`${row.candidate} contains ${other}`);assert.ok(row.jsBytes>0);}
});
