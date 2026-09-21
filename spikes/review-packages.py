"""Read-only registry and official-tag provenance check; not a security audit."""
import json, urllib.request, pathlib, datetime
packages = [('gridstack','13.2.0','gridstack/gridstack.js','v13.2.0','package.json'),('react-grid-layout','2.2.4','react-grid-layout/react-grid-layout','v2.2.4','package.json'),('react','19.2.8','facebook/react','v19.2.8','packages/react/package.json'),('react-dom','19.2.8','facebook/react','v19.2.8','packages/react-dom/package.json'),('vite','8.2.2','vitejs/vite','v8.2.2','packages/vite/package.json'),('typescript','7.0.2','microsoft/TypeScript','v7.0.2','package.json'),('@playwright/test','1.63.0','microsoft/playwright','v1.63.0','packages/playwright-test/package.json'),('@axe-core/playwright','4.13.0','dequelabs/axe-core-npm','v4.13.0','packages/playwright/package.json')]
rows=[]
for name, version, repo, tag, path in packages:
    row: dict = {'name':name,'version':version}
    for key,url in [('registry',f'https://registry.npmjs.org/{name}/{version}'),('official',f'https://raw.githubusercontent.com/{repo}/{tag}/{path}')]:
        try:
            with urllib.request.urlopen(url,timeout=30) as r: data=json.load(r)
            row[key]={'url':url,'name':data.get('name'),'version':data.get('version'),'license':data.get('license'),'repository':data.get('repository'),'engines':data.get('engines'),'scripts':data.get('scripts'),'dist':data.get('dist')}
        except Exception as e: row[key]={'url':url,'error':str(e)}
    rows.append(row)
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'note':'Provenance comparison only. Recent-publication heuristics are not security clearance.','packages':rows}
p=pathlib.Path('.planning/phases/01-editor-and-responsive-design-proof/evidence/package-review-execution.json');p.write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps(out,indent=2))
