# -*- coding: utf-8 -*-
"""答辩用 3 张联动对照图生成器（拼版，不改动任何原图界面内容）。

做法（Route A：Python + Pillow，离线）：
  把仓库里已有的界面截图按流程裁剪 → 拼到纸纹画布上 → 用 ImageDraw 画步骤编号、
  箭头、字段清单与底部说明。截图只做裁剪与缩放；intake 回执类截图使用
  tools/redact_intake.py 生成的「脱敏展示副本」，凭证值与完整查询码不出现在拼版中。

样式抄自 prototype-paper/screenshots/miniprogram/render.py（字体与配色一致）：
  字体 C:\\Windows\\Fonts\\msyh.ttc / msvcbd.ttc / simsun.ttc
  配色 PAPER #efe6d2 / PAPER2 #f6efe0 / CARD #fbf7ec / DESK #e8dfca /
        INK #2b2723 / INK2 #4a443d / MUTED #6f6556 / LINE #d8ccb6 / RED #b23a2a

用法：
  python prototype-paper/screenshots/link/render_link.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))

FONT_SERIF = r'C:\Windows\Fonts\simsun.ttc'
FONT_SANS = r'C:\Windows\Fonts\msyh.ttc'
FONT_SANS_B = r'C:\Windows\Fonts\msyhbd.ttc'

PAPER = '#efe6d2'
PAPER2 = '#f6efe0'
CARD = '#fbf7ec'
DESK = '#e8dfca'
INK = '#2b2723'
INK2 = '#4a443d'
MUTED = '#6f6556'
LINE = '#d8ccb6'
RED = '#b23a2a'
RED_WASH = '#f5e2d6'
AMBER = '#9a6a12'
GREEN = '#3f6b62'

W = 2000
MARGIN = 44
IMG_X = MARGIN
IMG_MAX_W = 1150
IMG_MAX_H = 520
TXT_X = 1258
TXT_W = W - TXT_X - MARGIN
CHROME_H = 40
BANNER_H = 56

_fc = {}


def serif(sz):
    key = ('s', sz)
    if key not in _fc:
        _fc[key] = ImageFont.truetype(FONT_SERIF, sz)
    return _fc[key]


def sans(sz, bold=False):
    key = ('y', sz, bold)
    if key not in _fc:
        _fc[key] = ImageFont.truetype(FONT_SANS_B if bold else FONT_SANS, sz)
    return _fc[key]


def ttext(d, xy, s, font, fill, bold=False):
    """宋体没有粗体文件，用 1px 描边模拟加粗（与 miniprogram/render.py 同做法）。"""
    if bold:
        d.text(xy, s, font=font, fill=fill, stroke_width=1, stroke_fill=fill)
    else:
        d.text(xy, s, font=font, fill=fill)


def wrap(text, font, maxw):
    lines, cur = [], ''
    for ch in text:
        if ch == '\n':
            lines.append(cur)
            cur = ''
            continue
        t = cur + ch
        if font.getlength(t) <= maxw or not cur:
            cur = t
        else:
            lines.append(cur)
            cur = ch
    if cur:
        lines.append(cur)
    return lines or ['']


def para(d, x, y, text, font, fill, maxw, lh=None):
    lines = wrap(text, font, maxw)
    lh = lh or int(font.size * 1.62)
    for i, ln in enumerate(lines):
        d.text((x, y + i * lh), ln, font=font, fill=fill)
    return y + len(lines) * lh


def load(rel):
    return Image.open(os.path.join(ROOT, rel.replace('/', os.sep))).convert('RGB')


def fit(img, maxw, maxh, cap=2.0):
    w, h = img.size
    s = min(maxw / w, maxh / h, cap)
    return img.resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS)


class Board:
    def __init__(self, title, subtitle, banner, sources):
        self.title = title
        self.subtitle = subtitle
        self.banner = banner
        self.sources = sources
        self.img = None
        self.d = None
        self.y = 0

    def new(self):
        self.img = Image.new("RGB", (W, 7200), DESK)
        # 纸纹：噪声先在 1/4 尺寸生成再放大，颗粒更接近纸纹，PNG 也小得多
        # （配色与 miniprogram/render.py 一致，噪声做柔化处理）。
        noise = Image.effect_noise((W // 4, 7200 // 4), 12).convert('L').resize((W, 7200), Image.BILINEAR)
        self.img = Image.blend(self.img, Image.merge('RGB', (noise, noise, noise)), 0.045)
        self.d = ImageDraw.Draw(self.img)

    def chrome(self):
        d = self.d
        d.rectangle([0, 0, W, CHROME_H], fill='#2b2723')
        note = '原型 / 本地演示截图 · 非线上真机数据'
        f = sans(15, True)
        d.text(((W - f.getlength(note)) / 2, 12), note, font=f, fill='#f6efe0')
        d.rectangle([0, CHROME_H, W, CHROME_H + 96], fill=PAPER)
        d.line([(0, CHROME_H + 96), (W, CHROME_H + 96)], fill=LINE, width=1)
        ft = serif(40)
        ttext(d, (MARGIN, CHROME_H + 22), self.title, ft, INK, True)
        fs = sans(16)
        d.text((MARGIN, CHROME_H + 68), self.subtitle, font=fs, fill=MUTED)
        self.y = CHROME_H + 96 + 26

    def arrow(self, x, y0, y1):
        """步骤之间的向下箭头。"""
        d = self.d
        d.line([(x, y0), (x, y1 - 10)], fill=RED, width=3)
        d.polygon([(x - 9, y1 - 12), (x + 9, y1 - 12), (x, y1)], fill=RED)

    def step(self, no, title, text, fields, crops, tone=RED):
        d = self.d
        top = self.y
        # ---- 左：截图
        x = IMG_X
        for rel, box in crops:
            im = load(rel)
            if box:
                l, t, r, b = box
                l = max(0, min(l, im.size[0]))
                r = max(l + 1, min(r, im.size[0]))
                t = max(0, min(t, im.size[1]))
                b = max(t + 1, min(b, im.size[1]))
                im = im.crop((l, t, r, b))
            im = fit(im, IMG_MAX_W, IMG_MAX_H)
            iw, ih = im.size
            d.rectangle([x - 3, top - 3, x + iw + 2, top + ih + 2], fill=CARD, outline=LINE, width=1)
            self.img.paste(im, (x, top))
            d.rectangle([x, top, x + iw - 1, top + ih - 1], outline=(178, 58, 42, 90), width=1)
            f = sans(12.5)
            d.text((x, top + ih + 9), '来源：' + rel + ('  ' + str(box) if box else ''), font=f, fill=MUTED)
            top += ih + 30
        img_bottom = top
        # ---- 右：编号 + 标题 + 说明 + 字段
        ty = self.y
        cx = TXT_X + 26
        r = 27
        d.ellipse([cx - r, ty - 4, cx + r, ty + 2 * r - 4], fill=tone)
        fn = serif(27)
        t = str(no)
        d.text((cx - fn.getlength(t) / 2, ty + 12), t, font=fn, fill='#f6efe0')
        ft = serif(27)
        ttext(d, (TXT_X + 66, ty + 2), title, ft, INK, True)
        fbody = sans(16.5)
        ny = para(d, TXT_X + 66, ty + 44, text, fbody, INK2, TXT_W - 66, 27)
        if fields:
            ny += 8
            fc = sans(14)
            cx2 = TXT_X + 66
            cy = ny
            for item in fields:
                tw = fc.getlength(item) + 20
                if cx2 + tw > TXT_X + TXT_W:
                    cx2 = TXT_X + 66
                    cy += 32
                d.rounded_rectangle([cx2, cy, cx2 + tw, cy + 25], radius=6, fill=RED_WASH, outline=(178, 58, 42, 90))
                d.text((cx2 + 10, cy + 5), item, font=fc, fill=INK2)
                cx2 += tw + 8
            ny = cy + 25
        band_h = max(img_bottom, ny + 6) - self.y
        # ---- 步骤之间的箭头
        if self.y > CHROME_H + 96:
            self.arrow(cx, self.y - 26, self.y - 4)
        self.y += band_h + 34

    def footer(self):
        d = self.d
        # 底部醒目说明条
        y = self.y + 6
        d.rectangle([0, y, W, y + BANNER_H], fill=RED)
        fb = sans(22, True)
        t = self.banner
        d.text(((W - fb.getlength(t)) / 2, y + 15), t, font=fb, fill='#f6efe0')
        y += BANNER_H
        d.rectangle([0, y, W, y + 92], fill=PAPER)
        d.line([(0, y), (W, y)], fill=LINE, width=1)
        fs = sans(13)
        yy = y + 12
        d.text((MARGIN, yy), '拼版来源（均为仓库内既有截图；仅裁剪与缩放；intake 回执类截图的凭证值已脱敏）：', font=sans(13, True), fill=INK)
        yy += 22
        for s in self.sources:
            d.text((MARGIN + 12, yy), '· ' + s, font=fs, fill=MUTED)
            yy += 19
        out = self.img.crop((0, 0, W, yy + 12))
        out.save(os.path.join(HERE, self.out), 'PNG', optimize=True)
        print(self.out, out.size)


# ================================================================ 图 1
def fig1():
    b = Board(
        '联动对照 01 · 游客诉求闭环',
        '导览端提交 → 回执 → 本机进度 → 公开查询与三维评价（字段名与按钮名均取自真实页面；回执值已脱敏）',
        '原型 / 本地演示截图 · 非线上真机数据',
        [
            'prototype-paper/screenshots/h5/01-home.png',
            'prototype-paper/screenshots/h5/20-feedback.png',
            'prototype-paper/screenshots/intake/01-receipt.png',
            'prototype-paper/screenshots/intake/02-panel-after-refresh.png',
            'prototype-paper/screenshots/intake/03-case-not-found.png',
            'prototype-paper/screenshots/intake/04-upstream-down.png',
            'prototype-paper/screenshots/miniprogram/04-public.png',
        ])
    b.new()
    b.chrome()
    b.step(1, '导览首页：底部「服务」入口',
           '游客在导览首页底部点「服务」，切到「反馈」页签填写诉求；页签还有「讲解员」「停车」。',
           ['底部导航：路线 / 扫码 / 服务 / 我的', '已点亮 0 / 7'],
           [('prototype-paper/screenshots/h5/01-home.png', (0, 1420, 780, 1688))])
    b.step(2, '服务 · 反馈：填写诉求',
           '原型反馈表单字段：类型、描述、图片（可选）、联系方式（可选），提交按钮「提交反馈」。接入层把它换成接诉即办表单。',
           ['类型 / 描述 / 图片（可选）/ 联系方式（可选）', '提交诉求'],
           [('prototype-paper/screenshots/h5/20-feedback.png', (0, 380, 780, 780))])
    b.step(3, '接入层表单：提交诉求',
           '接入层表单字段与按钮：发生时间、地点、类型、问题描述、建议处理部门（选填）、联系方式（选填）、现场照片（选填，最多 3 张，每张不超过 5 MiB），按钮「提交诉求」；旁注「办理效率：暂无经授权公开的数据。」',
           ['发生时间 / 地点 / 类型 / 问题描述', '建议处理部门（选填）', '联系方式（选填）', '现场照片（选填，最多 3 张，每张不超过 5 MiB）', '提交诉求'],
           [('prototype-paper/screenshots/intake/02-panel-after-refresh.png', (10, 200, 380, 495))])
    b.step(4, '提交回执：工单编号 + 公开查询码（已脱敏）',
           '提交成功后页面换成回执：工单编号、公开查询码、本人私密凭证三项；本图为公开演示副本，三项值均已脱敏，私密凭证行已裁掉不展示，并保留「私密凭证不保存到本机」的原提示。',
           ['工单编号（已脱敏）', '公开查询码（已脱敏）', '私密凭证已裁掉不展示', '提交另一条诉求'],
           [('prototype-paper/screenshots/intake/01-receipt.png', (10, 245, 380, 400))])
    b.step(5, '我的诉求：刷新后仍可查进度',
           '本机只保存工单编号、公开查询码与提交时间；「我的诉求」面板显示状态与里程碑，点「重新查询」再拉一次进度。展示副本中的工单编号已脱敏。',
           ['工单编号（已脱敏）/ 提交时间 / 状态：已提交', '里程碑：1. 已提交', '重新查询'],
           [('prototype-paper/screenshots/intake/02-panel-after-refresh.png', (10, 525, 380, 800))])
    b.step(6, '公开查询：时间节点 + 三维评价',
           '凭公开查询码可看「可公开的时间节点」（只显示已发生、已受理、处理中等公开节点）；工单办结后可提交三维评价：处理速度、处理效果、服务态度。',
           ['可公开的时间节点', '处理速度 / 处理效果 / 服务态度', '提交评价', '确认解决', '提交补办申请'],
           [('prototype-paper/screenshots/miniprogram/04-public.png', (10, 445, 740, 615)),
            ('prototype-paper/screenshots/miniprogram/04-public.png', (10, 715, 740, 950))])
    b.step(7, '降级态：查不到 / 暂时查不到',
           '查不到时状态直说：状态：查不到该工单；上游异常时状态：暂时查不到进度，请稍后再试。不编造进度。展示副本中的工单编号已脱敏。',
           ['状态：查不到该工单', '状态：暂时查不到进度，请稍后再试', '工单编号（已脱敏）'],
           [('prototype-paper/screenshots/intake/03-case-not-found.png', (10, 620, 380, 815)),
            ('prototype-paper/screenshots/intake/04-upstream-down.png', (10, 465, 380, 630))],
           tone=AMBER)
    b.out = '01-游客诉求闭环.png'
    b.footer()


# ================================================================ 图 2
def fig2():
    b = Board(
        '联动对照 02 · 处置流转闭环',
        '队列计数 → 工单列表 → 工单详情 → 处理 → 办理动作与角色 → 复核与结案（左侧为纸质原型运营台 4 阶段演示，右侧为接诉即办 10 状态 / 13 动作 / 3 角色）',
        '原型 / 本地演示截图 · 非线上真机数据',
        [
            'prototype-paper/screenshots/miniprogram/06-staff.png',
            'prototype-paper/screenshots/ops/desk-01-overview.png',
            'prototype-paper/screenshots/ops/desk-02-tickets.png',
            'prototype-paper/screenshots/ops/desk-03-ticket-detail.png',
            'prototype-paper/screenshots/ops/desk-04-ticket-processing.png',
        ])
    b.new()
    b.chrome()
    b.step(1, '管理方工作台：7 个队列计数',
           '接诉即办工作台按队列统计待办，真实队列名与计数：待受理 12、待分派 8、处理中 34、待复核 6、补办待审核 3、临期 5、超时 2（示意图中的演示计数）。',
           ['待受理 12', '待分派 8', '处理中 34', '待复核 6', '补办待审核 3', '临期 5', '超时 2'],
           [('prototype-paper/screenshots/miniprogram/06-staff.png', (22, 282, 728, 448))])
    b.step(2, '运营台值班总览：4 张统计卡',
           '纸质原型运营台总览 4 张卡：待分派诉求、处理中诉求、待确认预约、实时车位（示范）；左侧导航为诉求工单、讲解预约、车场、点位内容。',
           ['待分派诉求', '处理中诉求', '待确认预约', '实时车位（示范）'],
           [('prototype-paper/screenshots/ops/desk-01-overview.png', (497, 189, 2464, 366))])
    b.step(3, '工单列表：筛选 + 队列卡',
           '工单页筛选项与计数：未办结 3、待分派 2、已分派 1、处理中 0、待评价 1、全部 4；每张卡带 4 阶段时间线（已受理 / 已分派 / 处理中 / 待评价）与操作按钮。',
           ['未办结 3 / 待分派 2 / 已分派 1 / 处理中 0 / 待评价 1 / 全部 4', 'CD-DEMO-0001 · 示范', '按钮：分派 / 开始处理 / 办结，待评价'],
           [('prototype-paper/screenshots/ops/desk-02-tickets.png', (497, 186, 1587, 278)),
            ('prototype-paper/screenshots/ops/desk-02-tickets.png', (497, 300, 2477, 620))])
    b.step(4, '工单详情：分派前',
           '详情字段：工单编号、提交时间、描述、联系方式（已隐藏 · 仅授权处理人员可见）、附图（演示版不上传图片，附图只在游客本机预览）、处理部门；分派给可选街道市政 / 环卫 / 文旅内容组 / 街区管理办。',
           ['工单编号 CD-20261120-0001', '联系方式：已隐藏 · 仅授权处理人员可见', '附图：演示版不上传图片', '处理部门：未分派', '分派给：选择部门'],
           [('prototype-paper/screenshots/ops/desk-03-ticket-detail.png', (497, 189, 1651, 870))])
    b.step(5, '工单详情：处理中',
           '状态标记「处理中」，处理记录逐条留痕（游客提交，系统受理 → 分派给环卫 → 开始现场处理）；完成后按钮变为「办结，待评价」。',
           ['状态：处理中', '处理记录 3 条', '按钮：办结，待评价'],
           [('prototype-paper/screenshots/ops/desk-04-ticket-processing.png', (497, 189, 1651, 832)),
            ('prototype-paper/screenshots/ops/desk-04-ticket-processing.png', (1677, 186, 2432, 448))])
    b.step(6, '办理动作与角色（接诉即办 13 个动作）',
           '接诉即办真实动作名与角色：值班人员 duty（受理 / 要求补材料 / 不予受理 / 分派 / 转派）、承办人 handler（接单 / 提交办理结果）、主管 supervisor（转派 / 退回承办 / 发布文字反馈 / 结案 / 通过补办 / 驳回补办 / 发布图片反馈）。「提交办理结果」要填处理说明，可上传照片；没上传照片必须写明原因。',
           ['duty 值班人员', 'handler 承办人', 'supervisor 主管', '提交办理结果（处理说明 + 照片）'],
           [('prototype-paper/screenshots/miniprogram/06-staff.png', (22, 900, 728, 1010))])
    b.step(7, '复核与结案',
           '处置侧 10 个状态：待受理、待补充材料、待分派、不予受理、已分派、处理中、待复核、待评价、已办结、补办待审核；「提交办理结果」后进入待复核，主管「发布文字反馈」后进入待评价，「结案」后进入已办结。导览端同一状态叫已提交 / 已受理，是同一套状态机。',
           ['待复核 6', '结案', '已办结', '协办任务：通过协办 / 退回补办 / 撤销协办'],
           [('prototype-paper/screenshots/miniprogram/06-staff.png', (22, 1080, 728, 1260))],
           tone=GREEN)
    b.out = '02-处置流转闭环.png'
    b.footer()


# ================================================================ 图 3
def fig3():
    b = Board(
        '联动对照 03 · 停车接驳联动',
        '选目的地与到达时刻 → 停车推荐 → 停车场卡片与预测 → 步行接驳与导航 → 到站讲解（含预测降级态）',
        '原型 / 本地演示截图 · 非线上真机数据 · 停车余位 / 费用 / 预测均为示范数据',
        [
            'prototype-paper/screenshots/parking/01-parking-normal.png',
            'prototype-paper/screenshots/h5/19-parking-point.png',
            'prototype-paper/screenshots/h5/10-route-nav.png',
            'prototype-paper/screenshots/h5/12-arrival-listen.png',
            'prototype-paper/screenshots/parking/03-parking-bad-artifact.png',
        ])
    b.new()
    b.chrome()
    b.step(1, '服务 · 停车：选目的地与到达时刻',
           '停车页先取目的地与到达时刻，再按偏好排序；页面自带「模拟数据」标签，说明预测与推荐是合成数据、接入真实数据后替换。',
           ['目的地：启明里', '到达时刻：演示日 2026-04-10 14:30', '偏好：省总时间 / 少走路', '模拟数据：接入真实数据后替换'],
           [('prototype-paper/screenshots/parking/01-parking-normal.png', (0, 480, 780, 1150))])
    b.step(2, '停车推荐卡片：余位 / 费用 / 步行 / 更新时间',
           '首选车场卡片给出综合分与到达时预计余位、费用、步行距离和预测更新时间；下列要点是卡片原文。示范数据，非真实车场数据。',
           ['首选：沿江停车场', '综合分 75.4', '到达时预计余位 5 个（区间 2—8）· 空置率约 4%', '步行 150 米 · 约 2 分钟 · 10 元 · 刚刚更新', '预计总时间约 9 分钟（驾车估算 5 分钟 + 步行 2 分钟 + 停车 2 分钟）', '费用 5 元/小时，按 2 小时停靠估算 10 元'],
           [('prototype-paper/screenshots/parking/01-parking-normal.png', (0, 1140, 780, 1688))])
    b.step(3, '停车场卡片：历史余位 + 1 小时预测',
           '点进停车场点位卡：5 / 120 余位、步行 150 米 · 5 元/小时 · 刚刚更新；曲线实线是历史余位、虚线是未来 1 小时预计；按钮「从这里出发排路线」即接驳起点。',
           ['沿江停车场 5 / 120 余位', '步行 150 米 · 5 元/小时 · 刚刚更新', '实线 · 历史余位 / 虚线 · 未来 1 小时（预计）', '预计 30 分钟后约 5 个（区间 2—8）· 空置率约 4%', '按钮：从这里出发排路线'],
           [('prototype-paper/screenshots/h5/19-parking-point.png', (0, 700, 780, 1520))])
    b.step(4, '步行接驳：沿街行程导航',
           '接驳路线在导览地图上导航：沿街行程 · 第 1/5 站、下一站 启明里，地图上标出路线、站点序号与沿江停车场 P 标记；点「到了」进入到站讲解。',
           ['沿街行程 · 第 1/5 站', '下一站：启明里', '按钮：行程单 / 到了', '沿江停车场 P 标记'],
           [('prototype-paper/screenshots/h5/10-route-nav.png', (0, 180, 780, 1500))])
    b.step(5, '到达：到站讲解',
           '到站自动进入讲解：到站讲解 · 普通话，点位「江门海关旧址」，已盖印小卡「开埠一九零四」；可关闭讲解或「去下一站：江门市博物馆长堤分馆」。',
           ['到站讲解 · 普通话', '已盖印 · 小卡「开埠一九零四」', '按钮：关闭讲解 / 看详情', '按钮：去下一站：江门市博物馆长堤分馆'],
           [('prototype-paper/screenshots/h5/12-arrival-listen.png', (0, 30, 780, 1330))])
    b.step(6, '降级态：预测产物不可用',
           '预测产物缺失或版本不兼容时，页面写明「预测暂不可用（产物缺失或版本不兼容），以上为静态示范数据」，并改用静态余位；接驳入口仍然保留。',
           ['示范数据', '沿江停车场 18 / 120 余位', '预测暂不可用（产物缺失或版本不兼容）', '按钮：从这里出发排路线'],
           [('prototype-paper/screenshots/parking/03-parking-bad-artifact.png', (0, 480, 780, 1290))],
           tone=AMBER)
    b.out = '03-停车接驳联动.png'
    b.footer()


if __name__ == '__main__':
    fig1()
    fig2()
    fig3()
