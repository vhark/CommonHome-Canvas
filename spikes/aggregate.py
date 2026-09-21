"""Aggregate actual records; never upgrade missing engines to passes."""
import json,pathlib,collections,datetime
root=pathlib.Path('.planning/phases/01-editor-and-responsive-design-proof/evidence')
report=json.loads((root/'playwright.json').read_text())
tests=[]
def walk(suite):
    for spec in suite.get('specs',[]):
        for test in spec['tests']:
            tests.append({'title':spec['title'],'project':test['projectName'],'status':test['results'][-1]['status'],'errors':test['results'][-1].get('errors',[])})
    for child in suite.get('suites',[]):walk(child)
for suite in report['suites']:walk(suite)
assert len(tests)==80, f'Expected 80 selected tests, got {len(tests)}'
projects=['chromium-reference','firefox-reference','webkit-reference','chromium-tablet','webkit-tablet']
matrices=[]
for project in projects:
    for candidate in ['native','gridstack','rgl']:
        for cols in [12,24]:
            key=f'{project}-{candidate}-{cols}'
            test=next(t for t in tests if t['project']==project and t['title']==f'{candidate} matrix {cols}: raw capability comparison')
            p=root/'comparison'/f'{key}.json'
            if test['status']=='passed':
                assert p.exists(),f'Missing evidence {p}'
                d=json.loads(p.read_text());assert d['complete']
            else:
                d={'id':key,'candidate':candidate,'columns':cols,'project':project,'complete':False,'realTouch':False,'status':'BLOCKED' if any('missing dependencies' in str(e) for e in test['errors']) else 'FAILED','errors':test['errors'],'rows':[],'evidence':'playwright.json'}
                (root/'comparison'/f'{key}-blocked.json').write_text(json.dumps(d,indent=2)+'\n')
            matrices.append(d)
assert len(matrices)==30
summary={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'testStats':report['stats'],'testCounts':dict(collections.Counter(t['status'] for t in tests)),'matrixCount':len(matrices),'completeMatrices':sum(d['complete'] for d in matrices),'realTouch':'BLOCKED: no physical device interaction observed','productionSelection':None,'candidates':[]}
for candidate in ['native','gridstack','rgl']:
    rows=[dict(r,matrix=d['id']) for d in matrices if d['candidate']==candidate for r in d['rows']]
    timing=[r for r in rows if 'samples' in r]
    assert all(len(r['samples'])==10 for r in timing)
    entry={'candidate':candidate,'matrixCount':sum(d['candidate']==candidate for d in matrices),'completeMatrices':sum(d['candidate']==candidate and d['complete'] for d in matrices),'rows':len(rows),'rowStatus':dict(collections.Counter(r['status'] for r in rows)),'samples':sum(len(r['samples']) for r in timing),'maxObservedScenarioP95Ms':max((r['p95'] for r in timing),default=None),'failures':[{'matrix':r['matrix'],'scenario':r['scenario'],'overflowIDs':r.get('overflowIDs'),'errors':r.get('errors')} for r in rows if r['status']=='FAIL'],'budgetFailures':[{'matrix':r['matrix'],'scenario':r['scenario'],'p95':r['p95']} for r in timing if r.get('budgetMet') is False]}
    summary['candidates'].append(entry)
summary['readyForSelection']=False
summary['scope']='Emulated browser laboratory results only. Capability FAIL rows are distinct from test harness exits; no OS packages installed.'
(root/'comparison-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2))
