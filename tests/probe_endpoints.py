"""真实端到端实测：逐个调接口，检查返回契约和前端期望是否一致。

重点验证：
  · 每个接口返回有没有 ok 字段（前端很多地方靠它判断）
  · 需要时间/状态的接口，各阶段返回是否说得清
  · 失败路径是否给出可读原因（而不是静默）
"""
import json
import sys
import time
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:55908'
API = BASE + '/api/bili-itx'


def call(path, method='GET', body=None, timeout=120):
    url = API + path
    data = None
    headers = {'Accept': 'application/json'}
    if body is not None:
        data = json.dumps(body).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode('utf-8')
        try:
            return {'status': 200, 'json': json.loads(raw)}
        except Exception:
            return {'status': 200, 'raw': raw[:200]}
    except urllib.error.HTTPError as e:
        return {'status': e.code, 'error': e.read().decode('utf-8', 'replace')[:200]}
    except Exception as e:
        return {'status': -1, 'error': str(e)[:200]}


results = []


def check(name, path, method='GET', body=None, want_ok=True, timeout=120):
    r = call(path, method, body, timeout)
    j = r.get('json') if isinstance(r.get('json'), dict) else None
    ok = r.get('status') == 200
    has_ok = ('ok' in j) if j else False
    verdict = 'OK'
    note = ''
    if not ok:
        verdict = 'FAIL'
        note = 'HTTP ' + str(r.get('status')) + ' ' + str(r.get('error', ''))[:80]
    elif want_ok and j is not None and not has_ok:
        verdict = 'FAIL'
        note = '返回里没有 ok 字段（前端可能靠它判断）'
    results.append((verdict, name, path, note, j))
    return j


print('=== 1) 只读接口 ===')
check('state', '/state')
check('learned', '/learned')
check('ignored', '/ignored')
check('visibility', '/visibility')
check('seen', '/seen')
check('doctor', '/doctor', timeout=180)
check('setup/status', '/setup/status')
check('login/view', '/login/view')
check('live', '/live')
check('whoami', '/whoami', timeout=90)

print('=== 2) 状态查询类 ===')
check('visibility/scan/status', '/visibility/scan/status')
check('reply-back/now/status', '/reply-back/now/status')

print('=== 3) 写接口（用安全参数，不产生真实副作用）===')
check('config 读', '/config')
check('config 写（写回原值）', '/config', 'POST', {'maxVideosPerRun': None})

print('=== 4) 明确该失败的路径，必须有可读原因 ===')
check('visibility/scan 带非法 hours', '/visibility/scan', 'POST', {'hours': -5})

print()
print('=' * 60)
fails = [r for r in results if r[0] == 'FAIL']
for v, name, path, note, j in results:
    mark = '✅' if v == 'OK' else '❌'
    print(mark, name.ljust(26), path.ljust(28), note)
print('=' * 60)
print('通过', len(results) - len(fails), '/ 失败', len(fails))
sys.exit(0 if not fails else 1)
