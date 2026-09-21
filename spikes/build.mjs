import {build} from 'vite';
import {readFileSync,readdirSync,writeFileSync,mkdirSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
const evidence=process.env.SPIKE_EVIDENCE||'.planning/phases/01-editor-and-responsive-design-proof/evidence';
const rows=[];
for(const candidate of ['native','gridstack','rgl']){
 // Independent builds remove the other engines, rather than hiding React in a shared chunk.
 await build({configFile:false,plugins:[{name:'candidate-entry',enforce:'pre',transform(code,id){if(id.endsWith('/spikes/candidates.ts'))return code.replace("const candidate=params.get('candidate')||'native'",`const candidate='${candidate}'`).replace(/let adapter:any;[\s\S]*?let doc=/,`const adapter=await import('./${candidate}.ts');\nlet doc=`);}}],build:{outDir:`dist/${candidate}`,target:'esnext',sourcemap:false,minify:true}});
 const files=readdirSync(`dist/${candidate}/assets`).map(name=>{const data=readFileSync(`dist/${candidate}/assets/${name}`);return {name,bytes:data.length,gzipBytes:gzipSync(data).length};});
 rows.push({candidate,files,jsBytes:files.filter(x=>x.name.endsWith('.js')).reduce((s,x)=>s+x.bytes,0),jsGzipBytes:files.filter(x=>x.name.endsWith('.js')).reduce((s,x)=>s+x.gzipBytes,0),adapterBytes:readFileSync(`spikes/${candidate}.ts`).length});
}
mkdirSync(evidence,{recursive:true});writeFileSync(`${evidence}/bundles.json`,JSON.stringify(rows,null,2));console.log(JSON.stringify(rows,null,2));
