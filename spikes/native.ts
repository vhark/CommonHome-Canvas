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
let cancel=()=>{};
let active=false;
export function cancelGesture(){cancel();}

export function render(el:HTMLElement,doc:any,r:any,edit:boolean,operate:any,select=(id:string)=>{},validate=(op:any)=>({ok:true,error:null})){
 const focused=el.contains(document.activeElement)?document.activeElement?.getAttribute('aria-label'):null;
 cancel();el.className='native';el.replaceChildren();el.style.gridTemplateColumns=`repeat(${r.cols}, 1fr)`;
 if(r.error)return;
 for(const a of r.items){
  const w=doc.widgets.find((x:any)=>x.id===a.id),card=document.createElement('article');
  card.dataset.id=a.id;card.className='widget';card.style.gridArea=`${a.y+1} / ${a.x+1} / span ${a.h} / span ${a.w}`;
  const p=document.createElement('p');p.textContent=w.text;card.append(p);
  if(edit){card.onclick=()=>select(a.id);card.onfocusin=()=>select(a.id);}
  if(edit)for(const resize of [false,true]){
   const handle=document.createElement('button');handle.className=resize?'resize-handle':'handle';handle.textContent=resize?'Resize':'Move';
   handle.setAttribute('aria-label',`${resize?'Resize':'Move'} ${a.id}`);handle.setAttribute('aria-describedby','native-help');card.append(handle);
   handle.onpointerdown=e=>{
    if(active||!e.isPrimary||e.button!==0)return;
    e.preventDefault();select(a.id);handle.focus({preventScroll:true});
    try{handle.setPointerCapture(e.pointerId);}catch{return;}
    active=true;
    const start={x:e.clientX,y:e.clientY},status=document.querySelector('#status')!,oldStatus=status.textContent;
    const ghost=document.createElement('div');ghost.className='gesture-preview';ghost.setAttribute('aria-hidden','true');el.append(ghost);
    let op:any;
    const update=(event:PointerEvent)=>{
     if(event.pointerId!==e.pointerId)return;
     const dx=Math.round((event.clientX-start.x)/r.pitch),dy=Math.round((event.clientY-start.y)/48);
     op=resize?{type:'resize',id:a.id,dw:dx,dh:dy}:{type:'move',id:a.id,dx,dy};
     const result=validate(op),x=a.x+(resize?0:dx),y=a.y+(resize?0:dy),w=a.w+(resize?dx:0),h=a.h+(resize?dy:0);
     Object.assign(ghost.style,{left:`${x*r.pitch}px`,top:`${y*48}px`,width:`${Math.max(0,w*r.pitch-16)}px`,height:`${Math.max(0,h*48-16)}px`});
     ghost.dataset.valid=String(result.ok);
     const message=`${resize?'Resize':'Move'} ${a.id}: column ${x+1}, row ${y+1}, ${w} by ${h} cells. ${result.ok?'Release to apply; Escape to cancel.':result.error}`;
     ghost.textContent=message;
     if(status.textContent!==message)status.textContent=message;
    };
    const finish=(up:PointerEvent)=>{
     if(up.pointerId!==e.pointerId)return;
     update(up);const operation=op;cancel();
     // A tap selects; it must not normalize/rewrite authored placement.
     if(operation.dx===0&&operation.dy===0||operation.dw===0&&operation.dh===0)return;
     operate(operation);
    };
    const interrupted=(event:PointerEvent)=>{if(event.pointerId===e.pointerId)cancel();};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')cancel();};
    const scrolled=()=>cancel();
    cancel=()=>{
     active=false;cancel=()=>{};ghost.remove();status.textContent=oldStatus;
     handle.removeEventListener('pointermove',update);handle.removeEventListener('pointerup',finish);
     handle.removeEventListener('pointercancel',interrupted);handle.removeEventListener('lostpointercapture',interrupted);
     window.removeEventListener('keydown',escape);window.removeEventListener('scroll',scrolled,true);
     if(handle.hasPointerCapture(e.pointerId))handle.releasePointerCapture(e.pointerId);
    };
    handle.addEventListener('pointermove',update);handle.addEventListener('pointerup',finish);
    handle.addEventListener('pointercancel',interrupted);handle.addEventListener('lostpointercapture',interrupted);
    window.addEventListener('keydown',escape);window.addEventListener('scroll',scrolled,true);update(e);
   };
  }
  el.append(card);
 }
 if(focused)Array.from(el.querySelectorAll('button')).find(b=>b.getAttribute('aria-label')===focused)?.focus({preventScroll:true});
}
