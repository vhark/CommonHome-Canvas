import {test,expect} from '@playwright/test';
import './matrix.ts';
import {fixture,applyCandidateOperation} from '../spikes/model.ts';
test('loopback operation HTTP parity and negative security boundary',async({request})=>{
 const data={doc:fixture('one',12),op:{type:'move',id:'w0',dx:0,dy:1},viewport:{width:1920,height:1080},set:12,edit:true};
 const response=await request.post('/__spike/operation',{data});expect(response.headers()['content-type']).toContain('application/json');expect(await response.json()).toEqual(applyCandidateOperation(data.doc,data.op,data.viewport,data.set,true));
 for(const [headers,body,status] of [[{origin:'https://evil.example'},data,403],[{host:'evil.example'},data,403],[{'content-type':'text/plain'},'{}',415],[{},'x'.repeat(70000),413],[{},'{bad',400],[{}, {...data,doc:{widgets:[]}},400]]){const r=await request.post('/__spike/operation',{headers:{'content-type':'application/json',...headers},data:body});expect(r.status()).toBe(status);}
});
for(const candidate of ['native','gridstack','rgl']) test(`${candidate} Escape and pointercancel restore accepted state`, async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`/?candidate=${candidate}`);await page.getByRole('button',{name:'Edit layout',exact:true}).click();
 const before=await page.evaluate(()=>JSON.stringify(window.spike.candidateSnapshot().doc));
 for(const how of ['escape','pointercancel']) {
 await page.locator('[data-id="w0"] .handle').evaluate(el=>el.addEventListener('pointerdown',e=>(window as any).cancelPointerId=(e as PointerEvent).pointerId,{once:true}));
 const box=(await page.locator('[data-id="w0"] .handle').boundingBox())!;
 await page.mouse.move(box.x+24,box.y+24);await page.mouse.down();await page.mouse.move(box.x+24,box.y+120,{steps:8});
 if(how==='escape')await page.keyboard.press('Escape');else await page.locator('[data-id="w0"] .handle').dispatchEvent('pointercancel',{pointerId:await page.evaluate(()=>(window as any).cancelPointerId),pointerType:'touch'});
 await page.mouse.up();await page.waitForTimeout(50);
 expect(await page.evaluate(()=>JSON.stringify(window.spike.candidateSnapshot().doc))).toBe(before);
 }
 expect(errors).toEqual([]);
});
for(const candidate of ['native','gridstack','rgl']) test(`${candidate} mouse move and resize uses candidate engine`, async({page})=>{
 await page.goto(`/?candidate=${candidate}`);await page.getByRole('button',{name:'Edit layout',exact:true}).click();
 const handle=page.locator('[data-id="w0"] .handle');await expect(handle).toBeVisible();
 let box=(await handle.boundingBox())!;await page.mouse.move(box.x+24,box.y+24);await page.mouse.down();await page.mouse.move(box.x+24,box.y+120,{steps:12});await page.mouse.up();
 await expect.poll(async()=>page.evaluate(()=>window.spike.candidateSnapshot().resolved.items[0].y)).toBe(2);
 const scrollBeforeResize=await page.evaluate(()=>scrollY);
 const resize=page.locator('[data-id="w0"] .resize-handle, [data-id="w0"] .react-resizable-handle, .grid-stack-item .ui-resizable-se').first();box=(await resize.boundingBox())!;
 await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2,box.y+box.height/2+96,{steps:12});await page.mouse.up();
 await expect.poll(async()=>page.evaluate(()=>window.spike.candidateSnapshot().resolved.items[0].h)).toBe(6);
 // RGL's selection autoscroll amplified resize deltas. GridStack has a separate
 // intentional edge-autoscroll path; the exact h=6 assertion above still applies.
 if(candidate==='rgl')expect(await page.evaluate(()=>scrollY)).toBe(scrollBeforeResize);
});
test('gridstack resize at the viewport bottom edge commits the gesture height', async({page})=>{
 // GridStack starts its edge autoscroll one cellHeight from the bottom, and the
 // resizer adds whatever the page scrolled to the new height. A smooth scroll is
 // asynchronous, so the committed height otherwise depends on wall-clock timing
 // rather than on the gesture. Repeat: a single pass can pass by luck.
 await page.goto('/?candidate=gridstack');await page.getByRole('button',{name:'Edit layout',exact:true}).click();
 const observed:{h:number,scrolled:number}[]=[];
 for(let i=0;i<5;i++){
  await page.evaluate(()=>{scrollTo(0,0);window.spike.reset('one');});
  const move=page.locator('[data-id="w0"] .handle');let box=(await move.boundingBox())!;
  await page.mouse.move(box.x+24,box.y+24);await page.mouse.down();
  await page.mouse.move(box.x+24,box.y+120,{steps:12});await page.mouse.up();
  await expect.poll(()=>page.evaluate(()=>window.spike.candidateSnapshot().resolved.items[0].y)).toBe(2);
  const resize=page.locator('.grid-stack-item .ui-resizable-se').first();box=(await resize.boundingBox())!;
  const baseline=await page.evaluate(()=>scrollY);
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2+96,{steps:12});await page.mouse.up();
  await page.waitForTimeout(150);
  observed.push({h:await page.evaluate(()=>window.spike.candidateSnapshot().resolved.items[0].h),scrolled:await page.evaluate(()=>scrollY)-baseline});
 }
 // Height must be exactly the gesture's 96px / 48px = 2 extra cells every time.
 // The scroll bound is a secondary guard on the feedback loop itself: before the
 // fix this drifted 115-321px, so anything under a third of a cell shows the
 // autoscroll never ran away. It is not asserted as exactly zero because the
 // accepted document re-renders after resizestop and the browser may adjust the
 // scroll offset by a pixel or two for the new document height.
 expect(observed.map(o=>o.h)).toEqual([6,6,6,6,6]);
 expect(observed.filter(o=>Math.abs(o.scrolled)>16)).toEqual([]);
});
for(const candidate of ['native','gridstack','rgl']) test(`${candidate} tracer: explicit Edit and button operation`, async({page})=>{
 await page.goto(`/?candidate=${candidate}`);
 await expect(page.getByRole('button',{name:'Edit layout',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Edit layout',exact:true}).click();
 await page.getByRole('button',{name:'Move down',exact:true}).focus();await page.keyboard.press('Enter');
 const s=await page.evaluate(()=>window.spike.candidateSnapshot());expect(s.doc.base.items[0].y).toBe(1);
 await page.getByRole('button',{name:'Finish editing',exact:true}).click();
 const before=JSON.stringify(s.doc);await page.evaluate(()=>window.spike.applyCandidateOperation({type:'move',id:'w0',dx:1,dy:0}));
 expect(await page.evaluate(()=>JSON.stringify(window.spike.candidateSnapshot().doc))).toBe(before);
});
