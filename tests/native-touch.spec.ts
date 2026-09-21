import {test,expect} from '@playwright/test';
// Run only with --project=chromium-tablet: CDP touch injection, not physical touch.
test('native emulated touch drag and resize all six widgets; tap never authors placement',async({page,context})=>{
 await page.goto('/?candidate=native');await page.locator('#edit').click();
 const cdp=await context.newCDPSession(page),snap=()=>page.evaluate(()=>window.spike.candidateSnapshot());
 for(let i=0;i<6;i++)for(const kind of ['Move','Resize']){
  await page.locator('#fixture').selectOption('six');const id=`w${i}`;
  await page.evaluate(id=>{const s=window.spike.candidateSnapshot(),a=s.resolved.items.find(a=>a.id===id);window.spike.applyCandidateOperation({type:'move',id,dx:-a.x,dy:s.resolved.rows-7-a.y});},id);
  const handle=page.getByRole('button',{name:`${kind} ${id}`,exact:true});await handle.scrollIntoViewIfNeeded();
  const before=await snap(page);await handle.tap();expect((await snap(page)).doc).toEqual(before.doc);
  await expect(page.getByLabel('Selected widget',{exact:true})).toHaveValue(id);
  const b=(await handle.boundingBox())!,x=b.x+b.width/2,y=b.y+b.height/2,scroll=await page.evaluate(()=>scrollY);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+48,id:1}]});
  await expect(page.locator('.gesture-preview')).toHaveAttribute('data-valid','true');expect((await snap(page)).doc).toEqual(before.doc);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await expect(page.locator('.gesture-preview')).toHaveCount(0);
  const after=(await snap(page)).resolved.items.find(a=>a.id===id),a=before.resolved.items.find(a=>a.id===id);
  expect(after).toEqual({...a,...(kind==='Move'?{y:a.y+1}:{h:a.h+1})});expect(await page.evaluate(()=>scrollY)).toBe(scroll);
 }
 await cdp.detach();
});
