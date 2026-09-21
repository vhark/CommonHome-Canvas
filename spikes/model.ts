/*
 * CommonHome Canvas - a privacy-first household display and dashboard system.
 * Copyright (C) 2026 CommonHome Canvas contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version. It is distributed WITHOUT ANY WARRANTY; without
 * even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR
 * PURPOSE. See the GNU Affero General Public License for details, and the
 * LICENSE file distributed with this program.
 */
// Disposable experiment semantics, not the product schema.
export type Cell = {id:string,x:number,y:number,w:number,h:number};
export type Doc = {widgets:{id:string,kind:string,text:string,minWidth:number,minHeight:number}[],base:{cols:number,items:Cell[]},overrides:Record<string,{cols:number,items:Cell[]}>};
// Conservative shared text capacity, deliberately not a browser font-measurement API.
// 16px text / 24px lines: reserve 1em per ASCII code point and 2em for fallback
// Unicode glyphs, plus 34px horizontal inset and 106px edit-control/border space.
// Normal HTML whitespace collapses; count the collapsed string, never truncate it.
export function contentHeight(text:string,width:number) {
 const perLine=Math.max(1,Math.floor((width-34)/16));
 let lines=1,used=0;
 for(const word of text.trim().split(/\s+/u)){
  const units=[...word].map(c=>c.codePointAt(0)!>127?2:1);
  // CSS prefers a word boundary before breaking a long unbroken run. Counting
  // only total characters misses the unused tail of each word-wrapped line.
  if(used&&used+1+units.reduce((a,b)=>a+b,0)>perLine){lines++;used=0;}
  else if(used)used++;
  for(const unit of units){if(used&&used+unit>perLine){lines++;used=0;}used+=unit;}
 }
 return lines*24+106;
}
export const overlap=(a:Cell,b:Cell)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
export function applyCandidateOperation(doc:Doc,op:any,v:{width:number,height:number},set=12,edit=true) {
  const fail=(error:string)=>({ok:false,doc,error});
  if(!edit)return fail('Enter Edit layout before changing placement.');
  if(!op||typeof op!=='object')return fail('Invalid operation.');
  const next=structuredClone(doc),r=resolve(doc,v,set),target=op.target||'base';
  if(!['base','landscape','portrait'].includes(target))return fail('Invalid target.');
  if(op.type==='reset'&&target!=='base'){delete next.overrides[target];return {ok:true,doc:next,error:null};}
  if(op.type==='override'&&target!=='base'){if(r.error)return fail(r.error);next.overrides[target]={cols:r.cols,items:r.items};return {ok:true,doc:next,error:null};}
  if(r.error)return fail(r.error);
  if(op.type==='configure') {
    const widget=next.widgets.find(x=>x.id===op.id);
    if(!widget||typeof op.text!=='string'||[...op.text].length>500)return fail('This text exceeds the supported length. Shorten it and try again.');
    const cell=r.items.find(x=>x.id===op.id)!;
    if(contentHeight(op.text,cell.w*r.pitch-16)>cell.h*48-16)return fail('This text does not fit this widget. Enlarge it or shorten the text and try again.');
    widget.text=op.text;return {ok:true,doc:next,error:null};
  }
  let items=structuredClone(r.items);
  if(op.type==='add') {
    // ponytail: adding across authored layouts needs an explicit placement policy; defer in this spike.
    if(target!=='base'||Object.keys(doc.overrides).length)return fail('Add widgets to Automatic base before creating orientation overrides. Reset existing overrides and select Automatic base to add.');
    if(next.widgets.length>=24)return fail('Too many widgets.');
    const id=`w${next.widgets.length}`;
    next.widgets.push({id,kind:'text',text:'A new synthetic note',minWidth:240,minHeight:144});
    items.push({id,x:0,y:0,w:Math.ceil(256/r.pitch),h:4});
    const source={cols:r.cols,items};if(target==='base')next.base=source;else next.overrides[target]=source;
    const result=resolve(next,v,set);if(result.error)return fail(result.error);
    source.items=result.items;return {ok:true,doc:next,error:null};
  }
  const visible=orientation(v),override=doc.overrides[visible];
  if(target!==visible&&(target!=='base'||override))return fail(`This target is not visible on the canvas. Select ${override?(visible==='landscape'?'Landscape override':'Portrait override'):'Automatic base'} to edit this view, or rotate to the target orientation.`);
  const a=items.find(x=>x.id===op.id), widget=doc.widgets.find(x=>x.id===op.id);
  if(!a||!widget)return fail('Select a widget.');
  const delta=op.type==='move'?[op.dx,op.dy]:op.type==='resize'?[op.dw,op.dh]:[];
  if(delta.length!==2||delta.some(x=>!Number.isSafeInteger(x)))return fail('Invalid operation.');
  if(op.type==='move'){a.x+=op.dx;a.y+=op.dy;}else {a.w+=op.dw;a.h+=op.dh;}
  if(a.w*r.pitch-16<widget.minWidth||a.h*48-16<widget.minHeight)return fail('This widget is too small to remain readable. Choose a larger size.');
  if(contentHeight(widget.text,a.w*r.pitch-16)>a.h*48-16)return fail('This text does not fit this widget. Enlarge it or shorten the text and try again.');
  if(a.x<0||a.y<0||a.x+a.w>r.cols||a.y+a.h>r.rows)return fail('This layout does not fit this viewport. Reduce content or choose another layout.');
  if(items.some(b=>a!==b&&overlap(a,b)))return fail('This position overlaps another widget. Move it to a free space.');
  if(target==='base')next.base={cols:r.cols,items};else next.overrides[target]={cols:r.cols,items};
  return {ok:true,doc:next,error:null};
}
export const orientation=(v:{width:number,height:number})=>v.width>=v.height?'landscape':'portrait';
export function fixture(name:string, cols=12):Doc {
  const n=name==='zero'?0:name==='one'?1:name==='stress'?24:6;
  return {widgets:Array.from({length:n},(_,i)=>({id:`w${i}`,kind:i%2?'clock':'text',text:i%2?'09:41 UTC':name==='long'?'W'.repeat(500):name==='unicode'?'مرحبا • 家 • café 🌿':'A calm synthetic note',minWidth:name==='mixed'&&i===0?320:240,minHeight:144})),base:{cols,items:Array.from({length:n},(_,i)=>({id:`w${i}`,x:0,y:0,w:Math.ceil(cols/4),h:4}))},overrides:{}};
}
export function resolve(doc:Doc,v:{width:number,height:number},set=12) {
  const cols=v.width>=900?set:set/2, pitch=(v.width+16)/cols,rows=Math.floor((v.height+16)/48);
  const source=doc.overrides[orientation(v)]||doc.base;
  const scaled=doc.widgets.map(widget=>{const raw=source.items.find(x=>x.id===widget.id)!;return {...raw,x:Math.round(raw.x*cols/source.cols),w:Math.max(Math.ceil((widget.minWidth+16)/pitch),Math.round(raw.w*cols/source.cols)),h:Math.max(raw.h,Math.ceil((Math.max(widget.minHeight,contentHeight(widget.text,Math.max(Math.ceil((widget.minWidth+16)/pitch),Math.round(raw.w*cols/source.cols))*pitch-16))+16)/48))};});
  if(scaled.every(a=>a.x>=0&&a.y>=0&&a.x+a.w<=cols&&a.y+a.h<=rows&&!scaled.some(b=>a!==b&&overlap(a,b)))) return {items:scaled,cols,pitch,rows,error:null};
  const items:Cell[]=[];let cursor=0;
  for(const widget of doc.widgets) {
    const raw=source.items.find(x=>x.id===widget.id)!;
    const w=Math.max(Math.ceil((widget.minWidth+16)/pitch),Math.round(raw.w*cols/source.cols)),h=Math.max(raw.h,Math.ceil((Math.max(widget.minHeight,contentHeight(widget.text,w*pitch-16))+16)/48));
    let found:Cell|undefined;
    // ponytail: bounded linear first-fit scan; no packing optimizer in a spike.
    for(let pos=cursor;pos<cols*rows;pos++) {const a={id:widget.id,x:pos%cols,y:Math.floor(pos/cols),w,h};if(a.x+w<=cols&&a.y+h<=rows&&!items.some(b=>overlap(a,b))){found=a;cursor=pos;break;}}
    // Preserve a valid authored location when it does not invert semantic order.
    const authored={id:widget.id,x:Math.round(raw.x*cols/source.cols),y:raw.y,w,h};
    if(authored.y*cols+authored.x>=cursor&&authored.x+w<=cols&&authored.y+h<=rows&&!items.some(b=>overlap(authored,b))) {
      // Only explicit overrides preserve positions; base uses stable automatic first fit.
      if(doc.overrides[orientation(v)]) found=authored;
    }
    if(!found)return {items:[],cols,pitch,rows,error:'This layout does not fit this viewport. Reduce content or choose another layout.'};
    cursor=found.y*cols+found.x;items.push(found);
  }
  return {items,cols,pitch,rows,error:null};
}
