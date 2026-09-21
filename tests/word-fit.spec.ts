import {test,expect} from '@playwright/test';
for(const candidate of ['native','gridstack','rgl'])test(`${candidate} word wrapping cannot accept text overflowing the control-safe area`,async({page})=>{
 await page.setViewportSize({width:1024,height:768});await page.goto(`/?candidate=${candidate}`);
 await page.getByRole('button',{name:'Edit layout',exact:true}).click();
 expect((await page.evaluate(()=>window.spike.applyCandidateOperation({type:'resize',id:'w0',dw:0,dh:3}))).ok).toBe(true);
 const before=await page.evaluate(()=>window.spike.candidateSnapshot().doc);
 const result=await page.evaluate(()=>window.spike.applyCandidateOperation({type:'configure',id:'w0',text:Array(10).fill('W'.repeat(10)).join(' ')}));
 expect(result.ok).toBe(false);
 expect(await page.evaluate(()=>window.spike.candidateSnapshot().doc)).toEqual(before);
});
