# -*- coding: utf-8 -*-
"""统一截图索引构建器（答辩素材总索引）。

产出：
  prototype-paper/screenshots/index.json          总索引（7 组：6 组素材 + link）
  prototype-paper/screenshots/<group>/index.json  各组子索引（结构一致）
  prototype-paper/screenshots/paper/index.json    纸质原型组子索引

注意：索引只登记可公开展示的脱敏截图，不登记任何原始证据；
原始证据保存在仓库外由本机用户控制的目录，不进入 Git。

约定：
  * 所有 file 一律使用「仓库根相对路径」，例如 prototype-paper/screenshots/h5/01-home.png，
    这样索引在任何 worktree / 检出目录下都指向同一张图，便于脚本核对「索引 == 磁盘」。
  * 每个 entry 形如 {"file": 相对路径, "label": 中文说明}。
  * 标签只描述截图里真实出现的内容，不臆造页面字段。

用法：
  python prototype-paper/screenshots/tools/build_index.py            # 写入索引
  python prototype-paper/screenshots/tools/build_index.py --check    # 只核对不写
"""
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..'))
SHOTS = os.path.join('prototype-paper', 'screenshots')
GENERATED = '2026-11-23'

# ---------------------------------------------------------------- 逐张标签
# 顺序即索引顺序（与磁盘文件顺序一致，方便人工核对）。
GROUPS = [
    {
        'key': 'h5',
        'label': '导览 H5 · 游客主流程',
        'dir': 'prototype-paper/screenshots/h5',
        'dirs': ['prototype-paper/screenshots/h5'],
        'index': 'h5/index.json',
        'capturedBy': 'prototype-paper/tests/pages.cjs（本机 Microsoft Edge 自动定位，viewport 390×844）',
        'capturedAt': '2026-11-23',
        'note': '游客侧导览主流程：首页街景、点位与讲解、盖印收卡、行程单三条路线、到站讲解、扫码到站、讲解预约、服务（讲解员/停车/反馈）与个人中心。',
        'files': [
            ('01-home.png', '首页 · 街景看楼'),
            ('02-point-card.png', '点位卡'),
            ('03-detail.png', '点位详情'),
            ('04-listen.png', '讲解（手动收听）'),
            ('05-reward.png', '收卡 · 盖印'),
            ('06-map-lit.png', '街景 · 点亮一栋后'),
            ('07-story.png', '故事线'),
            ('08-route-form.png', '沿街行程单 · 填写'),
            ('09-route-results.png', '三条候选路线'),
            ('10-route-nav.png', '沿街行程 · 地图导航'),
            ('11-itinerary.png', '行程单'),
            ('12-arrival-listen.png', '到站讲解'),
            ('13-route-complete.png', '路线完成'),
            ('14-scan.png', '扫码到站（模拟）'),
            ('15-guides.png', '服务 · 讲解员'),
            ('16-booking.png', '讲解预约'),
            ('17-booking-success.png', '预约已提交'),
            ('18-parking.png', '服务 · 停车'),
            ('19-parking-point.png', '停车场点位卡'),
            ('20-feedback.png', '服务 · 反馈'),
            ('21-feedback-success.png', '反馈已受理'),
            ('22-mine.png', '个人页 · 卡册'),
            ('23-mine-records.png', '个人页 · 预约与诉求'),
            ('24-journal.png', '游记回听'),
            ('25-listen-yue.png', '讲解 · 粤语'),
            ('pic-crop.png', '配图 · crop'),
            ('pic-mount.png', '配图 · mount'),
            ('pic-stamp.png', '配图 · stamp'),
            ('26-journal-empty.png', '游记回听 · 空状态'),
        ],
    },
    {
        'key': 'intake',
        'label': '接诉即办接入层 · 导览端回执与进度',
        'dir': 'prototype-paper/screenshots/intake',
        'dirs': ['prototype-paper/screenshots/intake'],
        'index': 'intake/index.json',
        'capturedBy': 'prototype-paper/tests/intake.cjs（本机 Microsoft Edge 自动定位，viewport 390×844）',
        'capturedAt': '2026-11-23',
        'note': '导览 H5 反馈表单接入接诉即办后的回执与查询：提交回执（工单编号/公开查询码/私密凭证，值已脱敏）、刷新后「我的诉求」里程碑，以及查不到工单、上游不可用两种降级态。01/02/04 均为公开展示用的脱敏副本，原始证据不入库。',
        'files': [
            ('01-receipt.png', '提交回执（脱敏展示副本）· 工单编号 / 公开查询码 / 本人私密凭证值均已遮挡 + 我的诉求'),
            ('02-panel-after-refresh.png', '我的诉求面板（脱敏展示副本）· 刷新后状态与里程碑 + 重新查询（工单编号已遮挡）'),
            ('03-case-not-found.png', '我的诉求面板 · 查不到该工单（降级态）'),
            ('04-upstream-down.png', '我的诉求面板（脱敏展示副本）· 暂时查不到进度（上游异常降级态，工单编号已遮挡）'),
        ],
    },
    {
        'key': 'ops',
        'label': '运营台 · 值班视角（桌面 + 手机）',
        'dir': 'prototype-paper/screenshots/ops',
        'dirs': ['prototype-paper/screenshots/ops'],
        'index': 'ops/index.json',
        'capturedBy': 'prototype-paper/tests/ops.cjs（本机 Microsoft Edge 自动定位，viewport 390×844 与 1280×800）',
        'capturedAt': '2026-11-23',
        'note': '运营台值班视角：诉求工单列表与详情、讲解预约、车场点位、点位内容维护，以及运营台操作后游客端「我的」「停车」的同步结果。',
        'files': [
            ('phone-01-overview.png', '值班总览（390×844）'),
            ('phone-02-tickets.png', '诉求工单（390×844）'),
            ('phone-03-ticket-detail.png', '工单详情 · 分派前（390×844）'),
            ('phone-04-ticket-processing.png', '工单详情 · 处理中（390×844）'),
            ('phone-05-bookings.png', '讲解预约 · 待确认（390×844）'),
            ('phone-06-parking.png', '车场 · 标记陈旧（390×844）'),
            ('phone-07-content.png', '点位内容（390×844）'),
            ('phone-08-guest-mine-synced.png', '游客端「我的」· 运营台处理后（390×844）'),
            ('phone-09-guest-parking-stale.png', '游客端停车 · 运营台标记陈旧后（390×844）'),
            ('desk-01-overview.png', '值班总览（1280×800）'),
            ('desk-02-tickets.png', '诉求工单（1280×800）'),
            ('desk-03-ticket-detail.png', '工单详情 · 分派前（1280×800）'),
            ('desk-04-ticket-processing.png', '工单详情 · 处理中（1280×800）'),
            ('desk-05-bookings.png', '讲解预约 · 待确认（1280×800）'),
            ('desk-06-parking.png', '车场 · 标记陈旧（1280×800）'),
            ('desk-07-content.png', '点位内容（1280×800）'),
        ],
    },
    {
        'key': 'parking',
        'label': '停车预测 · 正常与降级',
        'dir': 'prototype-paper/screenshots/parking',
        'dirs': ['prototype-paper/screenshots/parking'],
        'index': 'parking/index.json',
        'capturedBy': 'prototype-paper/tests/parking.cjs（本机 Microsoft Edge 自动定位，viewport 390×844）',
        'capturedAt': '2026-11-23',
        'note': '停车推荐卡片的正常态与降级态：余位/费用/步行距离与预测曲线、少走路偏好切换、预测产物损坏回退、无产物回退。图中数字均为本地示范数据。',
        'files': [
            ('01-parking-normal.png', '停车 · 正常预测卡片（模拟数据 + 预测曲线）'),
            ('02-parking-preference.png', '停车 · 偏好切换（少走路）'),
            ('03-parking-bad-artifact.png', '停车 · 坏产物回退（暂不可用）'),
            ('04-parking-no-artifact.png', '停车 · 无产物回退'),
        ],
    },
    {
        'key': 'miniprogram',
        'label': '微信小程序 · 6 页界面示意图',
        'dir': 'prototype-paper/screenshots/miniprogram',
        'dirs': ['prototype-paper/screenshots/miniprogram'],
        'index': 'miniprogram/index.json',
        'capturedBy': 'prototype-paper/screenshots/miniprogram/render.py（Pillow 静态绘制，750×1334）',
        'capturedAt': '2026-11-23',
        'note': '接诉即办微信小程序 6 页界面示意图（首页 / 提交诉求 / 我的诉求 / 公开查询 / 商户 / 管理方工作台）。仓库无微信开发者工具，为静态绘制示意图，非真机截图。',
        'files': [
            ('01-home.png', '首页 · 长堤风貌街（提交诉求 / 游客与居民 / 商户 / 管理方 四个入口）'),
            ('02-submit.png', '提交诉求 · 匿名表单与提交回执（工单编号 / 公开查询码 / 私密凭证）'),
            ('03-mine.png', '我的诉求 · 本机回执夹（工单编号 / 公开查询码 / 提交时间）与进度查询'),
            ('04-public.png', '公开查询 · 里程碑时间线、补件上传与三维评价'),
            ('05-merchant.png', '商户 · 身份核验、本商户工单、提交诉求与协办送审'),
            ('06-staff.png', '管理方工作台 · 7 个队列计数、工单列表、13 个办理动作与督办协办'),
        ],
    },
    {
        'key': 'paper',
        'label': '纸质原型 · 像素导览与汇总大图',
        'dir': 'prototype-paper/screenshots',
        'dirs': ['prototype/screenshots', 'prototype-paper/screenshots'],
        'index': 'paper/index.json',
        'capturedBy': 'prototype/tests/mobile.cjs（像素导览 390×844）+ prototype-paper 汇总大图导出',
        'capturedAt': '2026-11-22',
        'note': '像素版导览原型的走查截图（首页 / 点位 / 点亮 / 路线 / 停车 / 卡册），以及纸质原型的三张汇总大图：导览端汇总、运营台汇总、点位卡配图对比。',
        'files': [
            ('prototype/screenshots/01-home.png', '像素导览 · 首页街景地图'),
            ('prototype/screenshots/02-point.png', '像素导览 · 点位卡（点位摘要与讲解）'),
            ('prototype/screenshots/03-lit.png', '像素导览 · 收卡盖印后点亮街景'),
            ('prototype/screenshots/04-route-preview.png', '像素导览 · 三条候选路线预览'),
            ('prototype/screenshots/05-parking.png', '像素导览 · 服务 · 停车（余位曲线）'),
            ('prototype/screenshots/06-album.png', '像素导览 · 个人页卡册与预约 / 诉求'),
            ('prototype-paper/screenshots/board-h5.png', '导览端汇总大图（游客主流程长图）'),
            ('prototype-paper/screenshots/board-ops.png', '运营台汇总大图'),
            ('prototype-paper/screenshots/pic-compare.png', '点位卡配图三种做法对比'),
        ],
    },
    {
        'key': 'link',
        'label': '联动对照图 · 3 张流程对照',
        'dir': 'prototype-paper/screenshots/link',
        'dirs': ['prototype-paper/screenshots/link'],
        'index': 'link/index.json',
        'capturedBy': 'prototype-paper/screenshots/link/render_link.py（Pillow 拼版现有截图并加标注）',
        'capturedAt': '2026-11-23',
        'note': '答辩用联动对照图：游客诉求闭环、处置流转闭环、停车接驳联动。由已有截图拼版绘制，未改动任何原图界面内容。',
        'files': [
            ('prototype-paper/screenshots/link/01-游客诉求闭环.png', '联动对照 01 · 游客诉求闭环（提交→回执→查询→评价）'),
            ('prototype-paper/screenshots/link/02-处置流转闭环.png', '联动对照 02 · 处置流转闭环（队列→工单→办理→复核→关闭）'),
            ('prototype-paper/screenshots/link/03-停车接驳联动.png', '联动对照 03 · 停车接驳联动（余位→选场→接驳路线→到达）'),
        ],
    },
]


def group_entries(group):
    """返回该组的 [{file, label}]，file 为仓库根相对路径。"""
    out = []
    for item in group['files']:
        if isinstance(item, tuple):
            name, label = item
        else:
            name, label = item['file'], item['label']
        if '/' in name:
            rel = name
        else:
            rel = group['dir'].replace('\\', '/') + '/' + name
        out.append({'file': rel, 'label': label})
    return out


def build_master():
    groups = []
    for group in GROUPS:
        entries = group_entries(group)
        groups.append({
            'key': group['key'],
            'label': group['label'],
            'dir': group['dir'],
            'dirs': group['dirs'],
            'index': group['index'],
            'count': len(entries),
            'capturedBy': group['capturedBy'],
            'capturedAt': group['capturedAt'],
            'note': group['note'],
            'files': entries,
        })
    return {
        'generated': GENERATED,
        'generatedBy': 'prototype-paper/screenshots/tools/build_index.py',
        'pathBase': '仓库根（repo root）',
        'note': '全部截图来自本地演示与原型环境，不是线上真机截图；停车相关数字为示范数据。intake 回执类截图均为脱敏展示副本，原始证据不入库，仅保存在仓库外本机目录。',
        'groups': groups,
    }


def write_json(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write('\n')


def collect_disk_png():
    """扫描磁盘上各组涉及的目录，返回仓库根相对路径集合。"""
    dirs = set()
    for group in GROUPS:
        dirs.update(group['dirs'])
    found = set()
    for rel_dir in sorted(dirs):
        abs_dir = os.path.join(ROOT, rel_dir.replace('/', os.sep))
        if not os.path.isdir(abs_dir):
            continue
        for name in sorted(os.listdir(abs_dir)):
            if name.lower().endswith('.png') and os.path.isfile(os.path.join(abs_dir, name)):
                found.add(rel_dir.replace('\\', '/') + '/' + name)
    return found


def collect_index_png(master):
    found = set()
    for group in master['groups']:
        for entry in group['files']:
            found.add(entry['file'])
    return found


def main():
    master = build_master()
    check_only = '--check' in sys.argv

    disk = collect_disk_png()
    indexed = collect_index_png(master)
    missing = sorted(indexed - disk)
    extra = sorted(disk - indexed)

    print('索引组数：', len(master['groups']))
    for group in master['groups']:
        print('  - %-12s %2d 张  %s' % (group['key'], group['count'], group['label']))
    print('索引内文件数：', len(indexed))
    print('磁盘 PNG 数：', len(disk))
    print('索引缺失（磁盘没有）：', missing if missing else '无')
    print('磁盘遗漏（索引没有）：', extra if extra else '无')
    print('两边数量相等：', len(indexed) == len(disk) and not missing and not extra)

    if check_only:
        return 0 if (not missing and not extra) else 1

    for group in master['groups']:
        write_json(os.path.join(ROOT, SHOTS, group['index']), group['files'])
    write_json(os.path.join(ROOT, SHOTS, 'index.json'), master)
    print('已写入：', os.path.join(ROOT, SHOTS, 'index.json'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
