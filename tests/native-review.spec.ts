import {test,expect,Page} from '@playwright/test';
import {fixture} from '../spikes/model.ts';
const snap=(page:Page)=>page.evaluate(()=>window.spike.candidateSnapshot());
async function start(page:Page){await page.goto('/?candidate=native');await page.locator('#edit').click();}

for(const kind of ['Move','Resize'])test(`native R2 ${kind} rejects hidden targets in ghost and commit`,async({page})=>{
 await start(page);
 await page.locator('#target').selectOption('landscape');await page.locator('#create').click();
 for(const target of ['base','portrait']){
  await page.locator('#target').selectOption(target);const before=await snap(page);
  const handle=page.getByRole('button',{name:`${kind} w0`,exact:true});await handle.scrollIntoViewIfNeeded();const b=(await handle.boundingBox())!;
  await page.mouse.move(b.x+24,b.y+24);await page.mouse.down();await page.mouse.move(b.x+24,b.y+72,{steps:4});
  await expect(page.locator('.gesture-preview')).toHaveAttribute('data-valid','false');
  await expect(page.getByRole('status')).toContainText('Select Landscape override');
  const ghostMessage=await page.getByRole('status').textContent();await page.mouse.up();
  const after=await snap(page);expect(after.doc).toEqual(before.doc);expect(after.resolved).toEqual(before.resolved);
  expect(ghostMessage).toContain(after.error);await expect(page.getByRole('status')).toHaveText(after.error);
  expect(after.viewport).toEqual(before.viewport);expect(after.target).toBe(target);
 }
});

test('native R3 fixture reset synchronizes authored target and subsequent destination',async({page})=>{
 await start(page);await page.locator('#target').selectOption('landscape');await page.locator('#create').click();
 await page.locator('#fixture').selectOption('six');
 await expect(page.locator('#target')).toHaveValue('base');expect((await snap(page)).target).toBe('base');
 const before=await snap(page);await page.getByLabel('Selected widget',{exact:true}).selectOption('w5');
 await page.getByRole('button',{name:'Move down',exact:true}).click();
 const after=await snap(page);expect(after.error).toBe('');expect(after.doc.base).not.toEqual(before.doc.base);expect(after.doc.overrides).toEqual({});
 expect(after.doc.base.items.find(a=>a.id==='w5')!.y).toBe(before.resolved.items.find(a=>a.id==='w5')!.y+1);
});

test('native R4 keyboard rejection during pointer drag retains live feedback and cancels without writing',async({page})=>{
 await start(page);const before=await snap(page),handle=page.getByRole('button',{name:'Move w0',exact:true}),b=(await handle.boundingBox())!;
 await page.mouse.move(b.x+24,b.y+24);await page.mouse.down();await page.mouse.move(b.x+24,b.y+72,{steps:4});
 await expect(page.locator('.gesture-preview')).toHaveAttribute('data-valid','true');
 await page.getByRole('button',{name:'Move left',exact:true}).focus();await page.keyboard.press('Enter');
 const after=await snap(page);expect(after.error).toContain('does not fit');
 await expect(page.getByRole('status')).toHaveText(after.error);await expect(page.locator('.gesture-preview')).toHaveCount(0);
 await page.mouse.up();expect((await snap(page)).doc).toEqual(before.doc);await expect(page.getByRole('status')).toHaveText(after.error);
 await expect(page.getByRole('button',{name:'Move left',exact:true})).toBeFocused();
});

test('native R1 add rejection preserves document through rotation and API round trips',async({page,request})=>{
 await start(page);
 await page.locator('#target').selectOption('landscape');await page.locator('#create').click();
 const before=await snap(page);
 await page.getByRole('button',{name:'Add widget',exact:true}).click();
 await expect(page.getByRole('status')).toContainText('Add widgets to Automatic base before creating orientation overrides');
 expect((await snap(page)).doc).toEqual(before.doc);
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const v=page.viewportSize()!;await page.setViewportSize({width:v.height,height:v.width});
 expect((await snap(page)).resolved.error).toBeNull();expect((await snap(page)).doc).toEqual(before.doc);expect(errors).toEqual([]);
 // Every emitted document must remain admissible at the actual HTTP boundary.
 for(const target of ['base','landscape','portrait'])for(const overrides of [false,true]){
  let doc=overrides?before.doc:fixture('one');
  for(const op of [{type:'add',target},{type:'move',target:'base',id:'w0',dx:0,dy:1},{type:'configure',id:'w0',text:'Round trip'}]){
   const response=await request.post('/__spike/operation',{data:{doc,op,viewport:before.viewport,set:12,edit:true}});
   expect(response.status()).toBe(200);const result=await response.json();
   if(op.type==='add')expect(result.ok).toBe(!overrides&&target==='base');
   if(!result.ok)expect(result.doc).toEqual(doc);
   doc=result.doc;
   const ids=doc.widgets.map(w=>w.id).sort();
   for(const layout of [doc.base,...Object.values(doc.overrides)] as any[])expect(layout.items.map(a=>a.id).sort()).toEqual(ids);
  }
 }
});
