import {test,expect} from '@playwright/test';
import {fixture,applyCandidateOperation} from '../spikes/model.ts';
for(const candidate of ['native','gridstack','rgl'])test(`${candidate} horizontal inputs, interrupted rotation and mode exit`,async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`/?candidate=${candidate}`);await page.getByRole('button',{name:'Edit layout',exact:true}).click();
 const reset=()=>page.evaluate(()=>window.spike.reset('one'));
 const snap=()=>page.evaluate(()=>window.spike.candidateSnapshot());
 for(const input of info.project.name.includes('tablet')?['mouse','keyboard','tap']:['mouse','keyboard']){
  await reset();const before=await snap();
  if(input==='mouse'){
   const handle=page.locator('[data-id="w0"] .handle');await handle.scrollIntoViewIfNeeded();const b=(await handle.boundingBox())!;
   await page.mouse.move(b.x+24,b.y+24);await page.mouse.down();await page.mouse.move(b.x+24+before.resolved.pitch,b.y+24,{steps:10});await page.mouse.up();
  }else {const button=page.getByRole('button',{name:'Move right',exact:true});if(input==='tap')await button.tap();else {await button.focus();await page.keyboard.press('Enter');}}
  await expect.poll(async()=>(await snap()).resolved.items[0].x).toBe(1);
  if(input==='mouse'){
   const handle=page.locator('[data-id="w0"] .resize-handle,[data-id="w0"] .react-resizable-handle,.grid-stack-item .ui-resizable-se').first();const b=(await handle.boundingBox())!;
   await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2+before.resolved.pitch,b.y+b.height/2,{steps:10});await page.mouse.up();
  }else {const button=page.getByRole('button',{name:'Larger width',exact:true});if(input==='tap')await button.tap();else {await button.focus();await page.keyboard.press('Enter');}}
  await expect.poll(async()=>(await snap()).resolved.items[0].w).toBe(before.resolved.items[0].w+1);
 }
 for(const how of ['rotate','finish']){
  await reset();const before=JSON.stringify((await snap()).doc);const b=(await page.locator('[data-id="w0"] .handle').boundingBox())!;
  await page.mouse.move(b.x+24,b.y+24);await page.mouse.down();await page.mouse.move(b.x+24,b.y+120,{steps:8});
  if(how==='rotate'){const v=page.viewportSize()!;await page.setViewportSize({width:v.height,height:v.width});await page.waitForTimeout(100);}else {await page.getByRole('button',{name:'Finish editing',exact:true}).focus();await page.keyboard.press('Enter');}
  await page.mouse.up();await page.waitForTimeout(50);expect(JSON.stringify((await snap()).doc)).toBe(before);
 }
 expect(errors).toEqual([]);
});
test('every exposed operation has HTTP parity and rejects unknown document members',async({request})=>{
 let doc=fixture('one',12);const viewport={width:1920,height:1080};
 for(const op of [{type:'configure',id:'w0',text:'مرحبا • 家'}, {type:'resize',id:'w0',dw:1,dh:1},{type:'move',id:'w0',dx:1,dy:1},{type:'override',target:'landscape'},{type:'override',target:'portrait'},{type:'reset',target:'portrait'},{type:'reset',target:'landscape'},{type:'add'},{type:'resize',id:'w0',dw:100,dh:0}]){
  const expected=applyCandidateOperation(doc,op,viewport,12,true),response=await request.post('/__spike/operation',{data:{doc,op,viewport,set:12,edit:true}});expect(response.status()).toBe(200);expect(await response.json()).toEqual(expected);doc=expected.doc;
 }
 for(const bad of [{...doc,html:'<script>alert(1)</script>'},{...doc,widgets:[doc.widgets[0],doc.widgets[0]]}]){const response=await request.post('/__spike/operation',{data:{doc:bad,op:{type:'add'},viewport,set:12,edit:true}});expect(response.status()).toBe(400);}
 expect((await request.get('/.planning/STATE.md')).status()).toBe(404);
});
