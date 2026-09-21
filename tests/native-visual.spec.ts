import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {mkdirSync} from 'node:fs';
const evidence=process.env.SPIKE_EVIDENCE||'.planning/phases/01-editor-and-responsive-design-proof/evidence/native-slice/screenshots';
test('native editor and separate preview visual accessibility inspection',async({page},info)=>{
 mkdirSync(evidence,{recursive:true});const initial=page.viewportSize()!;
 await page.goto('/?candidate=native');await page.locator('#edit').click();await page.locator('#fixture').selectOption('six');
 for(const orientation of ['landscape','portrait']){
  await page.setViewportSize(orientation==='landscape'?initial:{width:initial.height,height:initial.width});
  await page.getByLabel('Selected widget',{exact:true}).selectOption('w5');
  await expect(page.locator('[data-id="w5"]')).toHaveAttribute('data-selected','true');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  for(const size of await page.locator('button,select').evaluateAll(els=>els.map(e=>({w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height})))){expect(size.w).toBeGreaterThanOrEqual(48);expect(size.h).toBeGreaterThanOrEqual(48);}
  expect(await page.locator('.widget').evaluateAll(els=>els.map(e=>({id:(e as HTMLElement).dataset.id,fit:e.scrollHeight<=e.clientHeight+1&&e.scrollWidth<=e.clientWidth+1})).filter(e=>!e.fit))).toEqual([]);
  expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);
  await page.screenshot({path:`${evidence}/${info.project.name}-${orientation}-editor.png`,fullPage:true});
  const popupPromise=page.waitForEvent('popup');await page.getByRole('button',{name:'Open separate preview',exact:true}).click();const preview=await popupPromise;
  await expect(preview.getByRole('heading',{name:'Screen preview',exact:true})).toBeVisible();
  // A popup starts with the context's viewport, not page.setViewportSize's override.
  await preview.setViewportSize(page.viewportSize()!);
  await expect.poll(()=>preview.evaluate(()=>window.spike.candidateSnapshot().viewport.width)).toBe(page.viewportSize()!.width-32);
  expect((await new AxeBuilder({page:preview}).analyze()).violations).toEqual([]);
  await preview.screenshot({path:`${evidence}/${info.project.name}-${orientation}-preview.png`,fullPage:true});await preview.close();
 }
 await page.setViewportSize(initial);await page.locator('#fixture').selectOption('one');
 const handle=page.getByRole('button',{name:'Move w0',exact:true}),b=(await handle.boundingBox())!;
 await page.mouse.move(b.x+24,b.y+24);await page.mouse.down();await page.mouse.move(b.x+24,b.y+72,{steps:5});
 await expect(page.locator('.gesture-preview')).toHaveAttribute('data-valid','true');
 await page.screenshot({path:`${evidence}/${info.project.name}-drag-preview.png`,fullPage:false});await expect(page.locator('.gesture-preview')).toBeVisible();await page.keyboard.press('Escape');await page.mouse.up();
});
