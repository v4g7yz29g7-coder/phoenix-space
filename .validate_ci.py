import yaml

with open('.github/workflows/ci.yml') as f:
    data = yaml.safe_load(f)

print('YAML valid: OK')
print('top-level keys:', list(data.keys()))
print('jobs:', list(data['jobs'].keys()))
steps = sum(len(j.get('steps', [])) for j in data['jobs'].values())
print('total steps:', steps)
assert 'on' in data, 'missing "on"'
assert 'jobs' in data, 'missing "jobs"'
n = sum(1 for _ in open('.github/workflows/ci.yml'))
print('line count:', n)
print('CRITERION >120 lines:', 'PASS' if n > 120 else 'FAIL')
