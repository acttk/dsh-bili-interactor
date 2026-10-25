from pathlib import Path

# 记忆也存 root：从楼中楼学到的，跳过去同样得走 root
p = Path('lib/learn.js')
s = p.read_text(encoding='utf-8')
old = """        rpid: entry.rpid ? String(entry.rpid) : '',"""
new = """        rpid: entry.rpid ? String(entry.rpid) : '',
        root: entry.root ? String(entry.root) : '',"""
if old not in s:
    raise SystemExit('MISS learn rpid')
s = s.replace(old, new, 1)
p.write_text(s, encoding='utf-8')
print('learn stores root')

# 客户端记忆链接：优先 root
p2 = Path('client.js')
c = p2.read_text(encoding='utf-8')
old2 = """            e.rpid ? h('a', {
              'data-bi-bv': '', href: cmtUrl(e.bvid, e.rpid),
              target: '_blank', rel: 'noreferrer', style: { color: '#22d3ee' },
              title: '直接滚到那条评论',
            }, '跳到来源评论') : null) : null)"""
new2 = """            (e.root || e.rpid) ? h('a', {
              'data-bi-bv': '', href: cmtUrl(e.bvid, e.root || e.rpid),
              target: '_blank', rel: 'noreferrer', style: { color: '#22d3ee' },
              title: '直接滚到那条评论（楼中楼跳的是整个楼）',
            }, (e.root && String(e.root) !== String(e.rpid)) ? '跳到来源楼' : '跳到来源评论') : null) : null)"""
if old2 not in c:
    raise SystemExit('MISS memory link')
c = c.replace(old2, new2, 1)
p2.write_text(c, encoding='utf-8')
print('memory link prefers root')
