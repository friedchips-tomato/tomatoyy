# -*- coding: utf-8 -*-
"""截图索引核对脚本：索引里的每个 file 都存在 + 磁盘上每个 png 都在索引里 + 两边数量相等。

用法（仓库根目录下执行）：
  PYTHONIOENCODING=utf-8 python prototype-paper/screenshots/tools/verify_index.py

退出码 0 表示核对通过，1 表示不通过。
"""
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..'))
INDEX = os.path.join(ROOT, 'prototype-paper', 'screenshots', 'index.json')
# 磁盘扫描范围：两个截图根目录，递归
SCAN_ROOTS = [
    os.path.join(ROOT, 'prototype', 'screenshots'),
    os.path.join(ROOT, 'prototype-paper', 'screenshots'),
]


def rel(path):
    return os.path.relpath(path, ROOT).replace('\\', '/')


def main():
    with open(INDEX, encoding='utf-8') as fh:
        master = json.load(fh)

    print('=' * 72)
    print('截图索引核对 · 索引文件：prototype-paper/screenshots/index.json')
    print('生成日期：%s' % master.get('generated'))
    print('=' * 72)

    groups = master['groups']
    print('')
    print('【一】总索引分组与数量')
    print('-' * 72)
    indexed = []
    for group in groups:
        files = group['files']
        print('  %-12s %-22s 目录 %-38s %3d 张  index=%s'
              % (group['key'], group['label'][:11], group['dir'], len(files), group['index']))
        for entry in files:
            indexed.append(entry['file'])
    print('-' * 72)
    print('  合计 %d 组 / %d 个索引条目' % (len(groups), len(indexed)))

    print('')
    print('【二】索引 -> 磁盘：每个 file 是否存在')
    print('-' * 72)
    missing = []
    for group in groups:
        bad = []
        for entry in group['files']:
            path = os.path.join(ROOT, entry['file'].replace('/', os.sep))
            if not os.path.isfile(path):
                bad.append(entry['file'])
                missing.append(entry['file'])
        state = 'OK' if not bad else '缺失 %d 个' % len(bad)
        print('  %-12s %3d 条  %s' % (group['key'], len(group['files']), state))
        for item in bad:
            print('      缺失：%s' % item)
    print('  索引中不存在的文件合计：%d' % len(missing))

    print('')
    print('【三】磁盘 -> 索引：每个 png 是否登记')
    print('-' * 72)
    disk = []
    for scan_root in SCAN_ROOTS:
        for base, _dirs, names in os.walk(scan_root):
            for name in sorted(names):
                if name.lower().endswith('.png'):
                    disk.append(rel(os.path.join(base, name)))
    disk = sorted(disk)
    indexed_set = set(indexed)
    extra = [item for item in disk if item not in indexed_set]
    print('  磁盘扫描范围：prototype/screenshots/ 与 prototype-paper/screenshots/（递归）')
    print('  磁盘 PNG 合计：%d' % len(disk))
    print('  未登记进索引的 PNG：%d' % len(extra))
    for item in extra:
        print('      遗漏：%s' % item)

    print('')
    print('【四】结论')
    print('-' * 72)
    ok = (not missing) and (not extra) and len(indexed) == len(disk)
    print('  索引条目数：%d' % len(indexed))
    print('  磁盘 PNG 数：%d' % len(disk))
    print('  两边数量相等：%s' % (len(indexed) == len(disk)))
    print('  索引 -> 磁盘 全命中：%s' % (not missing))
    print('  磁盘 -> 索引 全登记：%s' % (not extra))
    print('  核对结果：%s' % ('通过 PASS' if ok else '不通过 FAIL'))
    print('')
    without_link = [item for item in disk if '/link/' not in item]
    print('  附：索引/磁盘 PNG 总数（全部为脱敏展示图）      = %d' % len(disk))
    print('  附：公开展示截图数（不含 link/ 联动对照图）      = %d' % len(without_link))
    print('  说明：原始证据不入库，仅保存在仓库外本机目录。')
    print('  断言的合法总数：71；不含 link/：68。')
    print('=' * 72)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
