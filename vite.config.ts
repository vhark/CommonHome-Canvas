import {defineConfig} from 'vite';
import {applyCandidateOperation} from './spikes/model.ts';
export default defineConfig({server:{host:'127.0.0.1',port:4173,strictPort:true,cors:false,allowedHosts:['127.0.0.1','localhost'],hmr:{overlay:false},fs:{strict:true}},plugins:[{name:'local-spike-only',configureServer(server){server.middlewares.use(async(req,res,next)=>{
 const send=(status:number,value:any)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
 if(!['127.0.0.1:4173','localhost:4173'].includes(req.headers.host||'')||(req.headers.origin&&!['http://127.0.0.1:4173','http://localhost:4173'].includes(req.headers.origin)))return send(403,{error:'Loopback origin required.'});
 if(/^\/(?:\.planning|\.git|\.hermes)(?:\/|$)/.test(req.url||''))return send(404,{error:'Not served.'});
 if(req.url!=='/__spike/operation')return next();
 if(req.method!=='POST')return send(405,{error:'POST required.'});
 let body='',bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>65536)return send(413,{error:'Body limit exceeded.'});body+=chunk;}
 if(req.headers['content-type']?.split(';')[0]!=='application/json')return send(415,{error:'JSON required.'});
 try{const d=JSON.parse(body),doc=d.doc;
 const exact=(o:any,keys:string[])=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).every(k=>keys.includes(k));
 const integer=(n:any,min=0,max=10000)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
 if(!exact(d,['doc','op','viewport','set','edit'])||![12,24].includes(d.set)||typeof d.edit!=='boolean'||!exact(d.viewport,['width','height'])||!integer(d.viewport.width,240,4096)||!integer(d.viewport.height,144,4096)||!exact(doc,['widgets','base','overrides'])||!Array.isArray(doc.widgets)||doc.widgets.length>24||!exact(doc.overrides,['landscape','portrait']))throw Error();
 const ids=doc.widgets.map((w:any)=>w.id);if(new Set(ids).size!==ids.length)throw Error();
 for(const w of doc.widgets)if(!exact(w,['id','kind','text','minWidth','minHeight'])||typeof w.id!=='string'||!/^w[0-9]{1,2}$/.test(w.id)||!['text','clock'].includes(w.kind)||typeof w.text!=='string'||[...w.text].length>500||!integer(w.minWidth,240,4096)||!integer(w.minHeight,144,4096))throw Error();
 for(const layout of [doc.base,...Object.values(doc.overrides)] as any[])if(!exact(layout,['cols','items'])||![6,12,24].includes(layout.cols)||!Array.isArray(layout.items)||layout.items.length!==ids.length||new Set(layout.items.map((x:any)=>x.id)).size!==ids.length||layout.items.some((x:any)=>!exact(x,['id','x','y','w','h'])||!ids.includes(x.id)||!integer(x.x)||!integer(x.y)||!integer(x.w,1)||!integer(x.h,1)))throw Error();
 const opkeys={move:['type','id','dx','dy','target'],resize:['type','id','dw','dh','target'],configure:['type','id','text','target'],override:['type','target'],reset:['type','target'],add:['type','target']};
 if(!d.op||!Object.hasOwn(opkeys,d.op.type)||!exact(d.op,(opkeys as any)[d.op.type]))throw Error();
 return send(200,applyCandidateOperation(doc,d.op,d.viewport,d.set,d.edit));
 }catch{return send(400,{error:'Invalid bounded experiment payload.'});}
 });}}]});
