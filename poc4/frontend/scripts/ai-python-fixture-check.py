import hashlib
import pathlib
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

kind = sys.argv[1]
if kind not in {'console', 'fastapi'}:
    raise SystemExit('Expected console or fastapi')
seed = 'console' if kind == 'console' else 'web'
shutil.copytree('/opt/manao-python-templates/' + seed, '/workspace', dirs_exist_ok=True)
shutil.copytree('/fixtures/' + kind, '/workspace', dirs_exist_ok=True)
command = ['uv', '--no-config', '--no-python-downloads', 'add', '--group', 'test', 'pytest']
if kind == 'fastapi':
    command.append('httpx')
command += ['--no-sync', '--no-build', '--python', '/usr/local/bin/python3', '--default-index', 'https://mirrors.aliyun.com/pypi/simple/']
subprocess.run(command, check=True, timeout=180)
assert subprocess.run(['manao-python-dev-build', 'compile'], check=False, timeout=30).returncode == 0
for expected_exit in [1, 0]:
    outcome = subprocess.run(['manao-python-dev-build', 'test'], capture_output=True, text=True, timeout=180)
    if outcome.returncode != expected_exit:
        print(outcome.stdout, outcome.stderr)
    assert outcome.returncode == expected_exit, (kind, outcome.returncode, expected_exit)
    report = ET.parse('/tmp/manao-python-tests.xml')
    cases = list(report.iter('testcase'))
    failures = sum(len(case.findall('failure')) for case in cases)
    errors = sum(len(case.findall('error')) for case in cases)
    assert len(cases) == (1 if kind == 'console' else 2)
    assert failures == expected_exit and errors == 0
    print(f'FIXTURE {kind} exit={outcome.returncode} tests={len(cases)} failures={failures} errors={errors}', flush=True)
    if expected_exit == 1:
        path = pathlib.Path('/workspace/main.py' if kind == 'console' else '/workspace/app/main.py')
        source = path.read_text()
        fixed = source.replace('sum(values) + 1', 'sum(values)') if kind == 'console' else source.replace('"1,001"', '"1,000"')
        assert source != fixed
        path.write_text(fixed)
print('uv.lock SHA256=' + hashlib.sha256(pathlib.Path('/workspace/uv.lock').read_bytes()).hexdigest())
