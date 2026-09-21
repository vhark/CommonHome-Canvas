import {test,expect,Page} from '@playwright/test';
import {applyCandidateOperation} from '../spikes/model.ts';
const snap=(page:Page)=>page.evaluate(()=>window.spike.candidateSnapshot());
async function start(page:Page){await page.goto('/?candidate=native');await page.getByRole('button',{name:'Edit layout',exact:true}).click();}

test('native every widget can be selected and edited without losing keyboard focus',async({page},info)=>{
 await start(page);
 for(const input of ['keyboard','mouse',...(info.project.use.hasTouch?['tap']:[])])for(let i=0;i<6;i++){
  await page.locator('#fixture').selectOption('six');
  const id=`w${i}`;
  // Give this widget a free editable location, retaining all six real widgets.
  await page.evaluate(id=>{const s=window.spike.candidateSnapshot(),a=s.resolved.items.find(a=>a.id===id);window.spike.applyCandidateOperation({type:'move',id,dx:-a.x,dy:s.resolved.rows-6-a.y});},id);
  if(input==='keyboard'){await page.getByRole('button',{name:`Move ${id}`,exact:true}).focus();await page.keyboard.press('Enter');}
  else if(input==='tap')await page.locator(`[data-id="${id}"] p`).tap();
  else await page.locator(`[data-id="${id}"] p`).click();
  await expect(page.getByLabel('Selected widget', {exact:true})).toHaveValue(id);
  await expect(page.locator(`[data-id="${id}"]`)).toHaveAttribute('data-selected','true');
  for(const [label,op] of [['Move up',{type:'move',dx:0,dy:-1}],['Larger height',{type:'resize',dw:0,dh:1}],['Move left',{type:'move',dx:-1,dy:0}]] as const){
   const before=await snap(page),expected=applyCandidateOperation(before.doc,{...op,id},before.viewport,before.set,true);
   expect(expected.ok).toBe(label!=='Move left');
   const b=page.getByRole('button',{name:label,exact:true});
   if(input==='keyboard'){await b.focus();await page.keyboard.press('Enter');await expect(b).toBeFocused();}
   else if(input==='tap')await b.tap();else await b.click();
   expect((await snap(page)).doc).toEqual(expected.doc);
   if(!expected.ok)await expect(page.getByRole('status')).toHaveText(expected.error!);
   await expect(page.getByLabel('Selected widget',{exact:true})).toHaveValue(id);
  }
 }
});

for(const kind of ['move','resize'])test(`native ${kind} live preview is transient and commits exact geometry for every widget`,async({page})=>{
 await start(page);
 for(let i=0;i<6;i++){
  await page.locator('#fixture').selectOption('six');const id=`w${i}`;
  await page.evaluate(id=>{const s=window.spike.candidateSnapshot(),a=s.resolved.items.find(a=>a.id===id);window.spike.applyCandidateOperation({type:'move',id,dx:-a.x,dy:s.resolved.rows-7-a.y});},id);
  const handle=page.getByRole('button',{name:`${kind==='move'?'Move':'Resize'} ${id}`,exact:true});
  await handle.scrollIntoViewIfNeeded();const b=(await handle.boundingBox())!,before=await snap(page);
  await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();
  await page.mouse.move(b.x+b.width/2,b.y+b.height/2+48,{steps:6});
  const ghost=page.locator('.gesture-preview');await expect(ghost).toBeVisible();await expect(ghost).toHaveAttribute('data-valid','true');
  const a=before.resolved.items.find(a=>a.id===id),box=(await ghost.boundingBox())!,canvas=(await page.locator('#canvas').boundingBox())!;
  expect(box.y-canvas.y).toBeCloseTo((a.y+(kind==='move'?1:0))*48,0);
  expect(box.height).toBeCloseTo((a.h+(kind==='resize'?1:0))*48-16,0);
  expect((await snap(page)).doc).toEqual(before.doc);
  await page.mouse.up();await expect(ghost).toHaveCount(0);
  const expected=applyCandidateOperation(before.doc,kind==='move'?{type:'move',id,dx:0,dy:1}:{type:'resize',id,dw:0,dh:1},before.viewport,before.set,true);
  expect(expected.ok).toBe(true);expect((await snap(page)).doc).toEqual(expected.doc);
  await expect(page.getByRole('button',{name:`${kind==='move'?'Move':'Resize'} ${id}`,exact:true})).toBeFocused();
 }
});

for(const how of ['escape','pointercancel','lostcapture','rotate','finish','target','scroll'])test(`native gesture cancels on ${how} without writing`,async({page})=>{
 await start(page);const before=await snap(page),handle=page.getByRole('button',{name:'Move w0',exact:true});
 await handle.evaluate(el=>el.addEventListener('pointerdown',e=>(window as any).activePointerId=(e as PointerEvent).pointerId,{once:true}));
 const b=(await handle.boundingBox())!;await page.mouse.move(b.x+24,b.y+24);await page.mouse.down();await page.mouse.move(b.x+24,b.y+72,{steps:4});
 await expect(page.locator('.gesture-preview')).toBeVisible();
 if(how==='escape')await page.keyboard.press('Escape');
 if(how==='pointercancel')await handle.dispatchEvent('pointercancel',{pointerId:await page.evaluate(()=>(window as any).activePointerId)});
 if(how==='lostcapture'){
  await handle.evaluate(el=>{const id=(window as any).activePointerId;if(!el.hasPointerCapture(id))throw Error('Expected active capture');el.releasePointerCapture(id);});
  // Browsers process pending capture loss before the next pointer event.
  await page.mouse.move(b.x+25,b.y+72);
 }
 if(how==='rotate'){const v=page.viewportSize()!;await page.setViewportSize({width:v.height,height:v.width});}
 if(how==='finish'){await page.getByRole('button',{name:'Finish editing',exact:true}).focus();await page.keyboard.press('Enter');}
 if(how==='target')await page.locator('#target').selectOption('portrait');
 if(how==='scroll')await page.evaluate(()=>window.scrollBy(0,48));
 await expect(page.locator('.gesture-preview')).toHaveCount(0);await page.mouse.up();expect((await snap(page)).doc).toEqual(before.doc);
});

test('native rejects invalid preview and ignores nonprimary and foreign pointer events',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await start(page);const before=await snap(page);
 const handle=page.getByRole('button',{name:'Move w0',exact:true}),b=(await handle.boundingBox())!;
 for(const event of [{pointerId:9,isPrimary:false,button:0,pointerType:'touch'},{pointerId:10,isPrimary:true,button:2,pointerType:'mouse'}]){
  await handle.dispatchEvent('pointerdown',{...event,clientX:b.x+24,clientY:b.y+24});
  await handle.dispatchEvent('pointerup',{...event,clientX:b.x+24,clientY:b.y+72});
  await expect(page.locator('.gesture-preview')).toHaveCount(0);expect((await snap(page)).doc).toEqual(before.doc);
 }
 await page.mouse.move(b.x+24,b.y+24);await page.mouse.down();await page.mouse.move(b.x+24,b.y+72,{steps:4});
 const ghost=page.locator('.gesture-preview');await expect(ghost).toHaveAttribute('data-valid','true');const validBox=await ghost.boundingBox();
 for(const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture'])await handle.dispatchEvent(type,{pointerId:99,isPrimary:false,pointerType:'touch',button:0,clientX:b.x+200,clientY:b.y+200});
 await expect(ghost).toBeVisible();expect(await ghost.boundingBox()).toEqual(validBox);expect((await snap(page)).doc).toEqual(before.doc);
 await page.mouse.move(b.x+24,b.y-24,{steps:4});await expect(ghost).toHaveAttribute('data-valid','false');await expect(page.getByRole('status')).toContainText('does not fit');
 await page.mouse.up();await expect(ghost).toHaveCount(0);expect((await snap(page)).doc).toEqual(before.doc);expect(errors).toEqual([]);
});

for(const columns of [12,24])test(`native separate preview isolates accepted snapshot and reflows at actual viewport (${columns})`,async({page})=>{
 await page.goto(`/?candidate=native&columns=${columns}`);await page.locator('#edit').click();await page.locator('#fixture').selectOption('six');
 await page.locator('#target').selectOption('landscape');await page.locator('#create').click();
 const before=await snap(page);
 await expect(page.getByRole('button',{name:'Open separate preview',exact:true})).toBeVisible();
 const popupPromise=page.waitForEvent('popup');await page.getByRole('button',{name:'Open separate preview',exact:true}).click();const preview=await popupPromise;
 await expect(preview.getByRole('heading',{name:'Screen preview',exact:true})).toBeVisible();
 expect(new URL(preview.url()).searchParams.get('surface')).toBe('preview');
 await expect(preview.locator('.handle,.resize-handle,#operations,#fixture,#edit')).toHaveCount(0);
 const read=()=>preview.evaluate(()=>window.spike.candidateSnapshot());
 expect((await read()).doc).toEqual(before.doc);expect((await read()).resolved).toEqual(before.resolved);
 const rects=(p:Page)=>p.locator('.widget').evaluateAll(els=>els.map(el=>{const a=el.getBoundingClientRect(),c=el.parentElement!.getBoundingClientRect();return {id:(el as HTMLElement).dataset.id,x:a.x-c.x,y:a.y-c.y,w:a.width,h:a.height,text:el.querySelector('p')!.textContent};}));
 expect(await rects(preview)).toEqual(await rects(page));
 expect(await preview.evaluate(()=>window.opener)).toBeNull();
 await page.locator('#fixture').selectOption('one');expect((await read()).doc).toEqual(before.doc);
 const v=preview.viewportSize()!;await preview.setViewportSize({width:v.height,height:v.width});
 await expect.poll(async()=>(await read()).viewport.width).toBe(v.height-32);
 expect((await read()).doc).toEqual(before.doc);expect((await read()).resolved.error).toBeNull();
 await preview.reload();await expect(preview.getByRole('heading',{name:'Screen preview',exact:true})).toBeVisible();expect((await read()).doc).toEqual(before.doc);
 const closed=preview.waitForEvent('close');
 // Firefox can close the target before Playwright acknowledges the click.
 await preview.getByRole('button',{name:'Return to editor',exact:true}).click({noWaitAfter:true}).catch(error=>{if(!preview.isClosed()||!String(error).includes('Target page, context or browser has been closed'))throw error;});
 await closed;expect(preview.isClosed()).toBe(true);
 expect((await snap(page)).doc.widgets).toHaveLength(1);
});

test('native missing preview snapshot and blocked popup have actionable errors',async({page})=>{
 await page.goto('/?candidate=native&surface=preview');await expect(page.getByRole('status')).toContainText('Open a new preview from the editor');
 await expect(page.locator('.widget')).toHaveCount(0);
 await start(page);const before=await snap(page);await page.evaluate(()=>window.open=()=>null);
 await page.getByRole('button',{name:'Open separate preview',exact:true}).click();
 await expect(page.getByRole('status')).toContainText('Allow pop-ups');expect((await snap(page)).doc).toEqual(before.doc);
});

for(const columns of [12,24])test(`native orientation UI keeps both overrides and base isolated (${columns})`,async({page})=>{
 await page.goto(`/?candidate=native&columns=${columns}`);await page.locator('#edit').click();await page.locator('#fixture').selectOption('six');
 const base=(await snap(page)).doc.base,view=page.viewportSize()!;
 await page.locator('#target').selectOption('landscape');await page.locator('#create').click();const landscape=(await snap(page)).doc.overrides.landscape;
 await page.setViewportSize({width:view.height,height:view.width});await expect.poll(async()=>(await snap(page)).viewport.width).toBe(view.height-32);
 await page.locator('#target').selectOption('portrait');await page.locator('#create').click();
 await page.getByLabel('Selected widget',{exact:true}).selectOption('w5');await page.getByRole('button',{name:'Move down',exact:true}).click();
 await expect(page.getByRole('status')).toBeEmpty();const changed=(await snap(page)).doc;
 expect(changed.base).toEqual(base);expect(changed.overrides.landscape).toEqual(landscape);
 await page.setViewportSize(view);await expect.poll(async()=>(await snap(page)).viewport.width).toBe(view.width-32);expect((await snap(page)).doc).toEqual(changed);
 await page.setViewportSize({width:view.height,height:view.width});await expect.poll(async()=>(await snap(page)).viewport.width).toBe(view.height-32);expect((await snap(page)).doc).toEqual(changed);
 page.once('dialog',d=>d.accept());await page.locator('#reset').click();const reset=(await snap(page)).doc;
 expect(reset.overrides.portrait).toBeUndefined();expect(reset.base).toEqual(base);expect(reset.overrides.landscape).toEqual(landscape);
});
