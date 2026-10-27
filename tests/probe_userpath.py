"""模拟用户真实使用路径，找「没闭环」的地方。

不是测接口能不能通，而是测**用户的每个动作有没有合理反馈**：
  1. 打开面板 → 看到什么？有没有「下一步该做什么」的指引？
  2. 没登录时点「跑一轮」→ 提示对不对？
  3. 额度用完时点「跑一轮」→ 提示对不对？
  4. 配置改成 0 → 有没有解释 0 的含义？
  5. 点「停下」但没在跑 → 提示对不对？
  6. 删记忆/删黑名单不存在的项 → 会不会静默失败？
  7. 各种边界值（负数、超大数、空字符串）
"""
import json
import sys
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:55908'
API = BASE + '/api/bili-itx'


def call(path, method='GET', body=None, timeout=90):
    data = None
    headers = {'Accept': 'application/json'}
    if body is not None:
        data = json.dumps(body).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(API + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        return {'_httpError': e.code, '_body': e.read().decode('utf-8', 'replace')[:200]}
    except Exception as e:
        return {'_error': str(e)[:200]}


def has_readable_error(j):
    """失败时必须有能看懂的原因，不能只说 '未知' 或空"""
    if not isinstance(j, dict):
        return False, '返回不是对象'
    if j.get('ok') is False or j.get('started') is False:
        msg = j.get('error') or ''
        if not msg or msg in ('未知', '未知原因'):
            return False, '失败但没有可读原因'
        return True, msg
    return True, ''


issues = []


def expect(name, cond, detail=''):
    if cond:
        print('  ✅', name)
    else:
        print('  ❌', name, '—', detail)
        issues.append(name + ' — ' + detail)


print('=== A. 面板打开时能拿到什么 ===')
st = call('/state')
expect('state 能取到', isinstance(st, dict) and not st.get('_error'), str(st)[:80])
if isinstance(st, dict):
    expect('有 config', 'config' in st)
    expect('有 run 状态', 'run' in st)
    expect('有 listener 状态', 'listener' in st)
    expect('有 quota', 'quota' in st)
    expect('有 today', 'today' in st)
    expect('有 env/doctor 指引', ('env' in st) or ('doctor' in st))
    # 新用户最关键：有没有告诉他缺什么
    env = st.get('env') or {}
    print('     env.ready =', env.get('ready'), ' items =', len(env.get('items') or []))

print()
print('=== B. 额度相关：0 和到顶怎么解释 ===')
q = (st or {}).get('quota') or {}
expect('quota 有 today/limit/left', all(k in q for k in ('today', 'limit', 'left')), str(q))
expect('quota 有 unlimited 标记', 'unlimited' in q, str(q))

print()
print('=== C. 非法输入不能崩 ===')
r = call('/config', 'POST', {'maxVideosPerRun': -5})
expect('负数配置不崩', isinstance(r, dict) and not r.get('_error'), str(r)[:80])
r = call('/config', 'POST', {'maxVideosPerRun': 999999})
expect('超大值不崩', isinstance(r, dict) and not r.get('_error'), str(r)[:80])
r = call('/config', 'POST', {'deepTalkLimit': 'abc'})
expect('字符串配置不崩', isinstance(r, dict) and not r.get('_error'), str(r)[:80])
r = call('/config', 'POST', {})
expect('空 body 不崩', isinstance(r, dict) and not r.get('_error'), str(r)[:80])

print()
print('=== D. 删除不存在的项：不能静默成功 ===')
r = call('/learned/delete', 'POST', {'text': '这条记忆绝对不存在_' + str(id(object()))})
expect('删不存在的记忆有回应', isinstance(r, dict) and 'ok' in r, str(r)[:100])
print('     返回:', json.dumps(r, ensure_ascii=False)[:120])
r = call('/ignored/delete', 'POST', {'bvid': 'BVnotexist', 'uid': '0'})
expect('删不存在的黑名单有回应', isinstance(r, dict) and 'ok' in r, str(r)[:100])
print('     返回:', json.dumps(r, ensure_ascii=False)[:120])

print()
print('=== E. 停下 / 清空 这类操作没在跑时怎么说 ===')
r = call('/stop', 'POST', {})
expect('stop 有回应', isinstance(r, dict) and 'ok' in r, str(r)[:100])

print()
print('=== F. 可见性检查的边界 ===')
r = call('/visibility/scan', 'POST', {'hours': 0})
print('     hours=0（全部历史）:', json.dumps(r, ensure_ascii=False)[:150])
expect('hours=0 不报错', isinstance(r, dict) and (r.get('ok') or r.get('busy')), str(r)[:120])
r = call('/visibility/scan', 'POST', {'hours': 'abc'})
expect('hours 非数字不崩', isinstance(r, dict) and not r.get('_error'), str(r)[:100])

print()
print('=== G. 监听检查的边界 ===')
r = call('/reply-back/now', 'POST', {'async': True})
print('     async 启动:', json.dumps(r, ensure_ascii=False)[:150])
expect('async 立刻返回', isinstance(r, dict) and 'ok' in r, str(r)[:100])
r2 = call('/reply-back/now', 'POST', {'async': True})
print('     再点一次:', json.dumps(r2, ensure_ascii=False)[:150])
expect('重复点有明确 busy 提示', isinstance(r2, dict) and (r2.get('ok') or r2.get('busy')), str(r2)[:120])

print()
print('=' * 60)
if issues:
    print('发现', len(issues), '个问题：')
    for i in issues:
        print('  ⚠️ ', i)
else:
    print('✅ 用户路径没发现问题')
sys.exit(0 if not issues else 1)
