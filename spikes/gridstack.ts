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
import {GridStack} from 'gridstack';
import 'gridstack/dist/gridstack.min.css';
let grid:any,epoch=0,unpin=()=>{};
export function render(el:HTMLElement,doc:any,r:any,edit:boolean,operate:any){
 epoch++;const current=epoch;unpin();if(grid)for(const item of grid.getGridItems()){GridStack.getDD().draggable(item,'destroy').resizable(item,'destroy');}grid?.destroy(false);el.replaceChildren();el.className='gridstack-host';
 const host=document.createElement('div');host.className='grid-stack';host.style.width='calc(100% + 16px)';el.append(host);
 GridStack.renderCB=(content,n)=>{content.classList.add('widget');content.dataset.id=n.id;const p=document.createElement('p');p.textContent=doc.widgets.find((x:any)=>x.id===n.id).text;content.append(p);if(edit){const handle=document.createElement('button');handle.className='handle';handle.textContent='Move';handle.setAttribute('aria-label',`Move ${n.id}`);content.append(handle);}};
 grid=GridStack.init({column:r.cols,cellHeight:48,marginTop:0,marginBottom:16,marginLeft:0,marginRight:16,float:true,animate:false,staticGrid:!edit,draggable:{handle:'.handle',scroll:false},resizable:{handles:'se'},alwaysShowResizeHandle:true},host);
 grid.load(r.items.map((a:any)=>({...a,minW:Math.ceil(256/r.pitch),minH:4})));
 // Resizing near the bottom edge feeds back on itself: gridstack always calls
 // Utils.updateScrollResize, and DDResizable._getChange adds the scrolled
 // distance to the height, which lengthens the page and keeps the pointer in the
 // scroll zone. The smooth scroll is async, so the committed height followed
 // animation timing rather than the gesture. resizable has no scroll:false
 // (draggable does), so pin the offset for the gesture only; scrollTo is needed
 // over assignment because assignment will not cancel a running smooth scroll.
 // Patching the library or the shared CSS would reach the other two candidates,
 // which do not have this fault.
 let pinned:number|undefined;
 const se=()=>document.scrollingElement!;
 const land=()=>se().scrollTo({top:pinned!,behavior:'instant'});
 const repin=()=>{if(pinned!==undefined&&se().scrollTop!==pinned)land();};
 // The final land is unconditional: a queued smooth scroll can still be in
 // flight while scrollTop already reads as pinned, and only a new scrollTo
 // cancels it.
 unpin=()=>{removeEventListener('scroll',repin,{capture:true});if(pinned!==undefined)land();pinned=undefined;};
 grid.on('resizestart',()=>{pinned=se().scrollTop;addEventListener('scroll',repin,{capture:true});});
 grid.on('dragstop resizestop',(event:any,item:any)=>{unpin();const id=item.gridstackNode.id,original=r.items.find((x:any)=>x.id===id);const n=item.gridstackNode;
 const op=event.type==='dragstop'?{type:'move',id,dx:n.x-original.x,dy:n.y-original.y}:{type:'resize',id,dw:n.w-original.w,dh:n.h-original.h};
 setTimeout(()=>{if(current===epoch)operate(op);},0);});
}
