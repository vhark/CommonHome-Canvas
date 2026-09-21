"""Aggregate real repair artifacts without erasing failed-run history.
Run from repository root after the serial recheck finishes.
"""
from pathlib import Path
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import re

root = Path.cwd()
evidence = root / '.planning/phases/01-editor-and-responsive-design-proof/evidence'
repair = evidence / 'repair'
available_projects = ['chromium-reference', 'firefox-reference', 'chromium-tablet']

def tests(report, projects, unique=True):
    rows = []
    def visit(suite):
        for spec in suite.get('specs', []):
            for test in spec['tests']:
                if test['projectName'] not in projects:
                    continue
                result = test['results'][-1]
                errors = '\n'.join(e.get('message', '') for e in result.get('errors', []))
                status = result['status']
                if status != 'passed' and 'Host system is missing dependencies' in errors:
                    status = 'unavailable'
                kind = 'collector-timeout' if 'Test timeout of 120000ms exceeded' in errors else 'assertion' if errors and status != 'unavailable' else None
                rows.append({'project': test['projectName'], 'title': spec['title'],
                             'status': status, 'failureKind': kind, 'report': report.name})
        for child in suite.get('suites', []):
            visit(child)
    visit(json.loads(report.read_text()))
    if unique:
        assert len(rows) == len({(r['project'], r['title']) for r in rows}), 'duplicate tests'
    return {'total': len(rows), 'counts': dict(Counter(r['status'] for r in rows)), 'tests': rows}

content = tests(repair / 'content-final.json', available_projects)
assert content['total'] == 27 and content['counts'] == {'passed': 27}
repeat = tests(repair / 'resize-repeat.json', available_projects, unique=False)
repeat_counts = {title: dict(Counter(r['status'] for r in repeat['tests'] if r['title']==title)) for title in {r['title'] for r in repeat['tests']}}
available = tests(repair / 'final-suite.json', available_projects)
webkit = tests(repair / 'final-suite.json', ['webkit-reference', 'webkit-tablet'])
recheck = tests(repair / 'serial-recheck.json', available_projects)
assert available['total'] == 87
assert webkit['total'] == 58 and webkit['counts'] == {'unavailable': 54, 'passed': 4}
failed_keys = {(r['project'], r['title']) for r in available['tests'] if r['status'] != 'passed'}
assert {(r['project'], r['title']) for r in recheck['tests']} == failed_keys
latest = {(r['project'], r['title']): r for r in available['tests']}
latest.update({(r['project'], r['title']): r for r in recheck['tests']})
assert len(latest) == 87

matrices = {}
for directory in ['final-comparison', 'serial-comparison']:
    for p in sorted((repair / directory).glob('*.json')):
        d = json.loads(p.read_text())
        d['reportPath'] = str(p.relative_to(repair))
        matrices[d['project'], d['candidate'], d['columns']] = d
expected = {(p, c, n) for p in available_projects for c in ['native', 'gridstack', 'rgl'] for n in [12, 24]}
assert set(matrices) == expected
assert all(d['complete'] for d in matrices.values())
assert all(not d['errors'] and not d['external'] for d in matrices.values())
candidates = {}
for candidate in ['native', 'gridstack', 'rgl']:
    subset = [d for d in matrices.values() if d['candidate'] == candidate]
    rows = [r for d in subset for r in d['rows']]
    status = dict(Counter(r['status'] for r in rows))
    assert status == {'PASS': 498}, (candidate, status)
    long_rows = [r for r in rows if '/long/content-visible' in r['scenario']]
    long_dispositions = dict(Counter(r['disposition'] for r in long_rows))
    assert long_dispositions == {'bounded composition': 8, 'explicit overflow; full source outside composition': 4}
    candidates[candidate] = {'completeMatrices': len(subset), 'capabilityRows': status,
        'longTextDispositions': long_dispositions, 'evidence': [d['reportPath'] for d in subset],
        'rawTimingSamples': sum(len(r.get('samples', [])) for r in rows)}

unit = {}
for name, count in [('model', 4), ('storage', 1), ('build-tests', 4)]:
    log = (repair / f'final-{name}.log').read_text()
    pass_match, fail_match = re.search(r'ℹ pass (\d+)', log), re.search(r'ℹ fail (\d+)', log)
    assert pass_match and fail_match, f'Incomplete Node test log: {name}'
    passed, failed = int(pass_match.group(1)), int(fail_match.group(1))
    assert (passed, failed) == (count, 0)
    unit[name] = {'passed': passed, 'failed': failed}
bundles = json.loads((repair / 'final-build/bundles.json').read_text())
assert {b['candidate'] for b in bundles} == {'native', 'gridstack', 'rgl'}
source_files = [*root.glob('spikes/*'), *root.glob('tests/*'), root/'playwright.config.ts', root/'package.json', root/'package-lock.json']
hash_file = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
summary = {'generatedAt': datetime.now(timezone.utc).isoformat(),
    'fullRunAvailable': available, 'webkit': webkit, 'serialRecheck': recheck,
    'latestAvailableCounts': dict(Counter(r['status'] for r in latest.values())),
    'retainedAvailableFailures': [r for r in available['tests'] if r['status'] != 'passed'],
    'warning': 'GridStack edge-autoscroll height assertion remains failed in serial testing. Do not claim a clean full run or universal gesture stability.',
    'contentRegressions': content, 'resizeRepeatCounts': repeat_counts,
    'unit': unit, 'candidates': candidates,
    'unavailableMatrixCount': sum(r['status']=='unavailable' and 'raw capability comparison' in r['title'] for r in webkit['tests']),
    'bundles': bundles, 'physicalTouch': 'UNVERIFIED: no physical device available',
    'gridSelected': False, 'laterPlansExecuted': False,
    'parallelVerificationWorkers': 3, 'timingsAreHardwareAcceptance': False,
    'sourceSHA256': {str(p.relative_to(root)): hash_file(p) for p in source_files if p.is_file()},
    'originalFailureEvidenceSHA256': {str(p.relative_to(evidence)): hash_file(p) for p in [
        evidence/'playwright.json', evidence/'full-matrix.log', evidence/'rgl-tablet-recheck.json',
        evidence/'rgl-tablet-recheck.log', evidence/'comparison-summary.json', evidence/'bundles.json']}}
(repair / 'verification-summary.json').write_text(json.dumps(summary, indent=2)+'\n')
print(json.dumps({k: v for k,v in summary.items() if k not in ['sourceSHA256','originalFailureEvidenceSHA256','fullRunAvailable','webkit','serialRecheck','bundles']}, indent=2))
print('Full available:', available['counts'], 'WebKit:', webkit['counts'], 'Serial:', recheck['counts'])
