# -*- coding: utf-8 -*-
"""长堤风貌街 · 微信小程序 6 页界面示意图生成器（静态绘制，非真机截图）。

内容全部来自仓库真实页面：
  changdi-intake/miniprogram/pages/home/index.(wxml|js)
  changdi-intake/miniprogram/pages/submit/index.wxml、pages/submit/submit.js
  changdi-intake/miniprogram/pages/mine/index.wxml
  changdi-intake/miniprogram/pages/public/index.wxml、pages/public/query.js
  changdi-intake/miniprogram/pages/merchant/index.wxml、pages/merchant/merchant.js
  changdi-intake/miniprogram/pages/staff/index.wxml、pages/staff/workbench.js

配色与纸质风原型一致（prototype-paper/paper.css）。
"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.dirname(os.path.abspath(__file__))
W, H = 750, 1334

FONT_SERIF = r'C:\Windows\Fonts\simsun.ttc'
FONT_SANS = r'C:\Windows\Fonts\msyh.ttc'
FONT_SANS_B = r'C:\Windows\Fonts\msyhbd.ttc'

# prototype-paper/paper.css 配色
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
RED_LINE = (178, 58, 42, 105)

NOTE = '界面示意图 · 仓库无微信开发者工具 · 未真机运行'
META = '#8a6a3f'

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
    """宋体没有粗体文件，用 1px 描边模拟加粗。"""
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
    lh = lh or int(font.size * 1.55)
    for i, ln in enumerate(lines):
        d.text((x, y + i * lh), ln, font=font, fill=fill)
    return y + len(lines) * lh


def tri(d, x, y, size, fill):
    d.polygon([(x, y), (x + size, y), (x + size / 2, y + size * 0.8)], fill=fill)


# ---------------------------------------------------------------- 元素工厂
def e_title(t, sz=15, color=INK, rule=True, bold=True):
    def f(ld, y, w):
        font = serif(sz)
        ttext(ld, (0, y), t, font, color, bold)
        tw = font.getlength(t)
        if rule:
            ld.line([(tw + 10, y + sz * 0.62), (w, y + sz * 0.62)], fill=(178, 58, 42, 60), width=1)
        return y + sz + 10
    return f


def e_cardtitle(t, sz=16):
    def f(ld, y, w):
        font = serif(sz)
        ttext(ld, (0, y), t, font, INK, True)
        return y + sz + 9
    return f


def e_body(t, sz=11.5, color=MUTED, lh=None, gap=4):
    def f(ld, y, w):
        font = sans(sz)
        lh2 = lh or int(sz * 1.62)
        ny = para(ld, 0, y, t, font, color, w, lh2)
        return ny + gap
    return f


def e_label(t, sz=11.5, color=INK2, gap=5):
    def f(ld, y, w):
        font = sans(sz, True)
        ld.text((0, y), t, font=font, fill=color)
        return y + int(sz * 1.3) + gap
    return f


def e_input(placeholder, value=None, h=31, sz=11.5):
    def f(ld, y, w):
        d = ld
        d.rectangle([0, y, w, y + h], fill='#fffdf6', outline=LINE, width=1)
        font = sans(sz)
        txt = value if value else placeholder
        col = INK if value else MUTED
        d.text((9, y + (h - font.size) // 2 - 2), txt, font=font, fill=col)
        return y + h + 8
    return f


def e_area(placeholder, value=None, h=58, sz=11.5):
    def f(ld, y, w):
        d = ld
        d.rectangle([0, y, w, y + h], fill='#fffdf6', outline=LINE, width=1)
        font = sans(sz)
        txt = value if value else placeholder
        col = INK if value else MUTED
        d.text((9, y + 7), txt, font=font, fill=col)
        return y + h + 8
    return f


def e_chip(t, h=28, sz=11.5):
    def f(ld, y, w):
        d = ld
        label = t.replace('▾', '').strip()
        font = sans(sz)
        tw = font.getlength(label)
        bw = tw + 34
        d.rectangle([0, y, bw, y + h], fill=PAPER2, outline=LINE, width=1)
        d.text((9, y + (h - font.size) // 2 - 2), label, font=font, fill=INK2)
        tri(d, bw - 18, y + (h - 8) // 2 + 1, 8, MUTED)
        return y + h + 8
    return f


def e_btn(t, kind='primary', h=32, sz=13, gap=8):
    """小程序里 button 是块级元素，按整行宽度画。"""
    def f(ld, y, w):
        d = ld
        font = sans(sz, True)
        if kind == 'text':
            d.text((0, y + (h - font.size) // 2 - 2), t, font=font, fill=RED)
            return y + h + gap
        if kind == 'primary':
            d.rectangle([0, y, w, y + h], fill=RED)
            col = '#ffffff'
        else:
            d.rectangle([0, y, w, y + h], fill=PAPER2, outline=RED_LINE, width=1)
            col = RED
        tw = font.getlength(t)
        d.text(((w - tw) / 2, y + (h - font.size) // 2 - 2), t, font=font, fill=col)
        return y + h + gap
    return f


def e_btnrow(items, h=32, sz=13, gap=8):
    """items: [(label, kind)]，kind 为 primary / secondary / text / chip。"""
    def f(ld, y, w):
        d = ld
        x = 0
        for label, kind in items:
            if kind == 'chip':
                label = label.replace('▾', '').strip()
            font = sans(sz, True)
            tw = font.getlength(label)
            if kind == 'text':
                if x + tw > w:
                    x = 0
                    y += h + 6
                d.text((x, y + (h - font.size) // 2 - 2), label, font=font, fill=RED)
                x += tw + 14
                continue
            bw = tw + 26
            if x + bw > w:
                x = 0
                y += h + 6
            if kind == 'primary':
                d.rectangle([x, y, x + bw, y + h], fill=RED)
                col = '#ffffff'
            elif kind == 'chip':
                d.rectangle([x, y, x + bw + 12, y + h], fill=PAPER2, outline=LINE, width=1)
                d.text((x + 13, y + (h - font.size) // 2 - 2), label, font=font, fill=INK2)
                tri(d, x + bw + 12 - 16, y + (h - 8) // 2 + 1, 8, MUTED)
                x += bw + 12 + 8
                continue
            else:
                d.rectangle([x, y, x + bw, y + h], fill=PAPER2, outline=RED_LINE, width=1)
                col = RED
            d.text((x + 13, y + (h - font.size) // 2 - 2), label, font=font, fill=col)
            x += bw + 8
        return y + h + gap
    return f


def e_hr(gap=8):
    def f(ld, y, w):
        ld.line([(0, y), (w, y)], fill=LINE, width=1)
        return y + gap
    return f


def e_timeline(items, sz=11.5, gap=8):
    """items: [(label, time)]，竖向里程碑。"""
    def f(ld, y, w):
        d = ld
        font = sans(sz, True)
        ftime = sans(sz - 1)
        for i, (label, time) in enumerate(items):
            r = 4
            cy = y + 7
            d.ellipse([6 - r, cy - r, 6 + r, cy + r], fill=RED)
            if i < len(items) - 1:
                d.line([(6, cy + r), (6, y + 30)], fill=(178, 58, 42, 70), width=1)
            d.text((20, y), label, font=font, fill=INK)
            tw = ftime.getlength(time)
            d.text((w - tw, y + 1), time, font=ftime, fill=MUTED)
            y += 30
        return y + gap
    return f


def e_kvrow(label, value, lsz=10, vsz=11, lw=104, gap=4):
    """左标签右值的一行明细。"""
    def f(ld, y, w):
        d = ld
        d.text((0, y), label, font=sans(lsz), fill=MUTED)
        d.text((lw, y - 1), value, font=sans(vsz), fill=INK)
        return y + max(lsz, vsz) + gap
    return f


def e_code(t, sz=14):
    def f(ld, y, w):
        font = sans(sz, True)
        ld.text((0, y), t, font=font, fill=RED)
        return y + sz + 10
    return f


def e_placeholder(h, label, sz=11):
    """表示页面上的图片位（如微信小程序查询码），非真实图片。"""
    def f(ld, y, w):
        d = ld
        for seg in range(0, int(w), 9):
            d.line([(seg, y), (min(seg + 5, w), y)], fill=LINE, width=1)
            d.line([(seg, y + h), (min(seg + 5, w), y + h)], fill=LINE, width=1)
        for seg in range(0, int(h), 9):
            d.line([(0, y + seg), (0, y + min(seg + 5, h))], fill=LINE, width=1)
            d.line([(w, y + seg), (w, y + min(seg + 5, h))], fill=LINE, width=1)
        font = sans(sz)
        tw = font.getlength(label)
        d.text(((w - tw) / 2, y + (h - font.size) / 2 - 2), label, font=font, fill=MUTED)
        return y + h + 8
    return f


def e_stars(active=3, total=5, gap=7, sz=11.5):
    def f(ld, y, w):
        d = ld
        for i in range(total):
            x = i * (sz + 9)
            if i < active:
                d.rectangle([x, y, x + sz, y + sz], fill=RED)
                d.text((x + 4, y + 1), str(i + 1), font=sans(sz - 3, True), fill='#ffffff')
            else:
                d.rectangle([x, y, x + sz, y + sz], outline=LINE, width=1)
                d.text((x + 4, y + 1), str(i + 1), font=sans(sz - 3, True), fill=MUTED)
        return y + sz + gap
    return f


def e_entry(title, desc, tsz=19, dsz=13.5, extra=0):
    def f(ld, y, w):
        d = ld
        ft = serif(tsz)
        ttext(ld, (0, y), title, ft, INK, True)
        ny = para(ld, 0, y + tsz + 8, desc, sans(dsz), MUTED, w - 30, int(dsz * 1.6))
        ar = sans(24)
        d.text((w - ar.getlength('›'), y + 2), '›', font=ar, fill=RED)
        return ny + 14 + extra
    return f


def e_caserow(title, tag, lines, tag_color=RED, tsz=12.5):
    def f(ld, y, w):
        d = ld
        ascii_len = sum(1 for ch in title if ch.isascii() and ch.isalnum())
        if ascii_len > 8:
            ft = sans(tsz - 0.5, True)
            ld.text((0, y), title, font=ft, fill=INK)
        else:
            ft = serif(tsz)
            ttext(ld, (0, y), title, ft, INK, True)
        if tag:
            ftag = sans(10, True)
            tagw = ftag.getlength(tag) + 14
            d.rectangle([w - tagw, y - 2, w, y + 18], fill=RED_WASH)
            d.text((w - tagw + 7, y + 1), tag, font=ftag, fill=tag_color)
        y += 22
        for ln in lines:
            y = para(ld, 0, y, ln, sans(11), MUTED, w, 17)
        return y + 10
    return f


def e_meta(t):
    """视图分隔标注（说明用，不属于应用界面）。"""
    def f(ld, y, w):
        font = sans(10.5, True)
        ld.text((0, y), t, font=font, fill=META)
        ld.line([(0, y + 15), (w, y + 15)], fill=LINE, width=1)
        return y + 20
    return f


def e_queue(items):
    """7 个队列计数按钮（标签与 id 来自 pages/staff/workbench.js）。"""
    def f(ld, y, w):
        d = ld
        cols = 4
        bw = (w - (cols - 1) * 8) / cols
        bh = 44
        for i, (label, count) in enumerate(items):
            r, cidx = divmod(i, cols)
            x = cidx * (bw + 8)
            yy = y + r * (bh + 8)
            d.rectangle([x, yy, x + bw, yy + bh], fill=PAPER2, outline=RED_LINE, width=1)
            f1 = sans(10.5, True)
            tw = f1.getlength(label)
            d.text((x + (bw - tw) / 2, yy + 8), label, font=f1, fill=INK2)
            f2 = serif(18)
            tw2 = f2.getlength(count)
            ttext(d, (x + (bw - tw2) / 2, yy + 24), count, f2, RED, True)
        rows = (len(items) + cols - 1) // cols
        return y + rows * (bh + 8)
    return f


# ---------------------------------------------------------------- 画布
class Canvas:
    def __init__(self, title, path='', idx=''):
        self.title = title
        self.path = path
        self.idx = idx
        self.y = 0
        self.pad = 24
        self.content_w = W - self.pad * 2

    def new(self):
        self.img = Image.new('RGB', (W, H), DESK)
        noise = Image.effect_noise((W, H), 10).convert('L')
        self.img = Image.blend(self.img, Image.merge('RGB', (noise, noise, noise)), 0.045)
        self.d = ImageDraw.Draw(self.img)

    def chrome(self):
        d = self.d
        d.rectangle([0, 0, W, 38], fill='#2b2723')
        f = sans(12.5, True)
        tw = f.getlength(NOTE)
        d.text(((W - tw) / 2, 11), NOTE, font=f, fill='#f6efe0')
        d.rectangle([0, 38, W, 38 + 72], fill=PAPER)
        d.line([(0, 38 + 72), (W, 38 + 72)], fill=LINE, width=1)
        ft = serif(19)
        tw = ft.getlength(self.title)
        ttext(d, ((W - tw) / 2, 38 + 24), self.title, ft, INK, True)
        self.y = 38 + 72 + 14

    def footer(self):
        d = self.d
        d.rectangle([0, H - 44, W, H], fill=PAPER)
        d.line([(0, H - 44), (W, H - 44)], fill=LINE, width=1)
        f = sans(11)
        d.text((14, H - 32), '来源：changdi-intake/miniprogram/' + self.path, font=f, fill=MUTED)
        f2 = sans(11, True)
        t = '示意图 ' + self.idx
        d.text((W - 14 - f2.getlength(t), H - 32), t, font=f2, fill=RED)

    def _layer(self, elements, pad, tail):
        layer = Image.new('RGBA', (self.content_w, 2400), (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        cy = pad
        for el in elements:
            cy = el(ld, cy, self.content_w - pad * 2)
        used = int(cy - tail + pad)
        return layer.crop((0, 0, self.content_w, max(used, 1)))

    def card(self, elements, bg=CARD, border=RED_LINE, pad=14, gap=10):
        layer = self._layer(elements, pad, gap)
        used = layer.size[1]
        x = self.pad
        d = self.d
        d.rectangle([x + 2, self.y + 2, x + self.content_w + 2, self.y + used + 2], fill=(60, 45, 30, 30))
        d.rectangle([x, self.y, x + self.content_w, self.y + used], fill=bg)
        d.rectangle([x, self.y, x + self.content_w, self.y + used], outline=border, width=1)
        self.img.paste(layer, (x + pad, self.y), layer)
        self.y += used + 10
        return self.y

    def plain(self, elements, gap=8):
        layer = self._layer(elements, 0, 0)
        used = layer.size[1]
        self.img.paste(layer, (self.pad, self.y), layer)
        self.y += used + gap
        return self.y

    def fade_bottom(self):
        """页面可下滑时，底部做渐隐，表示内容在视口之外。"""
        d = self.d
        h = 44
        for i in range(h):
            a = int(255 * (i / h) ** 1.5)
            d.rectangle([0, H - 44 - h + i, W, H - 44 - h + i + 1], fill=(232, 223, 202, a))

    def save(self, name):
        self.footer()
        self.img.save(os.path.join(OUT, name), 'PNG')
        print(name, self.img.size, 'content_bottom=', self.y)


# ---------------------------------------------------------------- 1 首页
def screen_home():
    c = Canvas('长堤风貌街', path='pages/home/index', idx='01/06')
    c.new()
    c.chrome()
    c.card([
        e_body('长堤风貌街', sz=30, color=INK, lh=38, gap=6),
        e_body('诉求一单受理，处置全程可查', sz=14, color=MUTED, lh=20, gap=0),
    ], bg=PAPER2, pad=24, gap=12)
    entries = [
        ('提交诉求', '匿名提交游客诉求并获取查询回执'),
        ('游客与居民', '我的诉求与进度查询'),
        ('商户', '核验商户身份后提交诉求、查看本商户工单与协办任务'),
        ('管理方', '核验工作人员身份后进入工作台'),
    ]
    for t, d in entries:
        c.card([e_entry(t, d, tsz=20, dsz=14, extra=16)], pad=24, gap=12)
    c.card([
        e_body('游客与居民可直接在这里提交诉求，提交后获得查询回执；回执会留在本机「我的诉求」中，'
               '也可凭回执中的公开查询码扫码或输码查询进度，核验本人后可查看反馈、补充材料、评价和申请补办。',
               sz=13, color=INK2, lh=22),
    ], pad=22, gap=12)
    c.save('01-home.png')


# ---------------------------------------------------------------- 2 提交诉求
def screen_submit():
    c = Canvas('提交诉求', path='pages/submit/index', idx='02/06')
    c.new()
    c.chrome()
    c.card([
        e_cardtitle('提交诉求'),
        e_body('游客可匿名提交诉求，提交后获得查询回执；凭回执可查询办理进度，核验本人后可查看反馈与补充材料。', sz=11),
        e_label('发生时间'),
        e_btnrow([('2026-11-23 ▾', 'chip'), ('09:30 ▾', 'chip')], h=28, sz=11.5),
        e_label('发生地点'),
        e_input('填写发生地点'),
        e_label('问题类别'),
        e_chip('街面维护 ▾'),
        e_label('问题描述'),
        e_area('填写问题经过与诉求', h=54),
        e_body('0 / 4000', sz=10.5, color=MUTED, gap=10),
        e_label('建议处理部门（选填）'),
        e_input('建议由哪个部门处理'),
        e_body('仅为建议，最终由管理方分派；最多 100 字，填写后随本次提交一起送出。', sz=10.5, lh=16, gap=2),
        e_body('0 / 100', sz=10.5, color=MUTED, gap=10),
        e_label('联系方式（选填）'),
        e_input('便于回访的联系方式'),
        e_body('联系方式仅授权处理人员可见，公开查询页不会显示。', sz=10.5, lh=16, gap=10),
        e_label('现场照片（选填，最多 3 张）'),
        e_btnrow([('选择照片', 'secondary'), ('清除照片', 'secondary')], h=30, sz=12),
        e_body('已选 0 张，每张不超过 5 MiB，仅 JPEG、PNG 或 WebP；照片可留空。', sz=10.5, lh=16, gap=8),
        e_btn('提交诉求', 'primary', h=34),
    ])
    c.plain([e_meta('提交成功后，同一页面切换为「提交回执」视图：')], gap=4)
    c.card([
        e_cardtitle('提交回执'),
        e_body('请立即保存以下信息。私密查询凭证仅显示一次，退出本页后无法再次查看。', sz=11),
        e_label('工单编号'),
        e_code('CD-4F2A9C13B7D5E8F0A6C4B2D9E1F3A57'),
        e_label('公开查询码'),
        e_code('K7Q2M4X9B3NT5VC8RD1WJ'),
        e_btn('复制公开查询码', 'secondary', h=30, sz=12),
        e_label('微信小程序查询码'),
        e_placeholder(96, '微信小程序查询码图片'),
        e_body('用微信扫一扫上面的码，直接进入公开进度页；查询码里只有公开查询码，不含私密凭证。', sz=10.5, lh=16, gap=8),
        e_label('私密查询凭证（仅显示一次）'),
        e_code('tok_9f2c7a41b6d84e0fa35c19d7b2e6084a', sz=12),
        e_body('私密凭证用于核验本人查看详情，请勿转发给他人。', sz=10.5, lh=16, gap=8),
        e_btnrow([('查看进度', 'primary'), ('再提交一条', 'secondary')], h=32, sz=13),
    ])
    c.save('02-submit.png')


# ---------------------------------------------------------------- 3 我的诉求
def screen_mine():
    c = Canvas('我的诉求', path='pages/mine/index', idx='03/06')
    c.new()
    c.chrome()
    c.card([
        e_cardtitle('我的诉求', sz=17),
        e_body('本机只保存工单编号、公开查询码与提交时间，用于查看最新公开进度。', sz=12),
        e_btnrow([('扫码查询', 'primary'), ('刷新', 'secondary')], h=32, sz=13),
        e_btnrow([('手动输码查询', 'secondary')], h=32, sz=13),
    ])
    c.card([
        e_label('工单编号', sz=11, gap=3),
        e_code('CD-4F2A9C13B7D5E8F0A6C4B2D9E1F3A57', sz=13.5),
        e_label('当前状态', sz=11, gap=3),
        e_body('待补充材料', sz=14, color=AMBER, lh=21, gap=7),
        e_label('最近节点', sz=11, gap=3),
        e_body('管理方要求补充材料：现场照片不清晰', sz=12, color=INK2, lh=19, gap=7),
        e_label('提交时间', sz=11, gap=3),
        e_body('2026-11-23 09:30', sz=12, color=INK2, lh=19, gap=7),
        e_btnrow([('查看', 'secondary')], h=30, sz=12),
    ])
    c.card([
        e_label('工单编号', sz=11, gap=3),
        e_code('CD-8B31D7C5E0A24F69D8C3B1A7E5F2D04', sz=13.5),
        e_label('当前状态', sz=11, gap=3),
        e_body('查询失败：网络超时', sz=14, color=RED, lh=21, gap=7),
        e_label('最近节点', sz=11, gap=3),
        e_body('暂无公开进度节点', sz=12, color=INK2, lh=19, gap=7),
        e_label('提交时间', sz=11, gap=3),
        e_body('2026-11-22 18:07', sz=12, color=INK2, lh=19, gap=7),
        e_btnrow([('查看', 'secondary'), ('重试', 'secondary')], h=30, sz=12),
    ])
    c.card([
        e_body('本机记录只用于快速查询，可随时清除。清除后需凭回执再次扫码或输码查询。', sz=12),
        e_btn('清除本机记录', 'secondary', h=31, sz=12.5),
    ])
    c.card([
        e_body('记录仅保存在本机，换手机或清除缓存后不再显示。私密查询凭证不在本机保存，'
               '如需查看本人详情，请在公开进度页凭私密凭证核验本人。', sz=12, color=INK2, lh=20),
    ])
    c.save('03-mine.png')


# ---------------------------------------------------------------- 4 公开查询
def screen_public():
    c = Canvas('查询进度', path='pages/public/index', idx='04/06')
    c.new()
    c.chrome()
    c.card([
        e_cardtitle('查询进度', sz=15),
        e_body('输入回执中的公开查询码，或扫描回执二维码查看办理进度。', sz=10.5),
        e_btn('返回首页', 'secondary', h=28, sz=11.5),
    ], pad=11, gap=7)
    c.plain([
        e_input('24 位公开查询码', value='K7Q2M4X9B3NT5VC8RD1WJ', h=32, sz=11.5),
        e_btnrow([('查询', 'primary'), ('扫码', 'secondary')], h=30, sz=12.5),
    ], gap=9)
    c.card([
        e_label('工单编号', sz=10.5, gap=2),
        e_code('CD-4F2A9C13B7D5E8F0A6C4B2D9E1F3A57', sz=12.5),
        e_label('当前状态', sz=10.5, gap=2),
        e_body('处理中', sz=12.5, color=AMBER, lh=19, gap=6),
        e_btn('核验本人查看详情', 'secondary', h=28, sz=11.5),
    ], pad=11, gap=7)
    c.card([
        e_title('可公开的时间节点', sz=14),
        e_timeline([
            ('已提交', '2026-11-23 09:31'),
            ('已受理', '2026-11-23 10:05'),
            ('处理中', '2026-11-23 11:20'),
        ], sz=11, gap=4),
    ], pad=11, gap=7)
    c.plain([e_meta('核验本人后可查看已发布反馈并办理本人事项：')], gap=3)
    c.card([
        e_title('核验本人', sz=13.5),
        e_body('请输入回执中的私密查询凭证。凭证仅用于本机核验，提交后即清空，不进入网址、日志或分享内容。',
               sz=10, lh=15),
        e_input('私密查询凭证', h=28, sz=11),
    ], pad=11, gap=7)
    c.card([
        e_title('我的操作', sz=13.5),
        e_label('处理速度', sz=10.5, gap=3),
        e_stars(active=4, sz=11, gap=4),
        e_label('处理效果', sz=10.5, gap=3),
        e_stars(active=4, sz=11, gap=4),
        e_label('服务态度', sz=10.5, gap=3),
        e_stars(active=5, sz=11, gap=5),
        e_input('意见（选填）', h=26, sz=11),
        e_btn('提交评价', 'primary', h=27, sz=11.5),
        e_hr(5),
        e_body('确认本事项已解决，工单将办结。未评分记为未评价。', sz=10, lh=14, gap=3),
        e_btn('确认解决', 'secondary', h=27, sz=11.5),
        e_hr(5),
        e_body('说明未解决的事项，由管理方审核后开启新一轮。', sz=10, lh=14, gap=3),
        e_area('未解决事项说明', h=36, sz=10.5),
        e_btn('提交补办申请', 'secondary', h=27, sz=11.5),
        e_hr(5),
        e_title('补充材料', sz=12.5, rule=False),
        e_body('管理方要求补充：现场照片不清晰', sz=10, lh=14, gap=3),
        e_area('补件说明（必填）', h=34, sz=10.5),
        e_body('说明必填，最多 4000 字。可选 1–3 张 JPEG、PNG 或 WebP，每张不超过 5 MiB。',
               sz=10, lh=14, gap=5),
        e_btn('选择补件照片', 'secondary', h=27, sz=11.5),
        e_btn('提交补件', 'primary', h=27, sz=11.5),
    ], pad=11, gap=7)
    c.card([
        e_body('本页仅显示工单编号、当前状态和可公开的时间节点，不显示申报内容、照片与联系方式。'
               '核验本人后可查看已发布反馈并办理本人事项。', sz=10, color=INK2, lh=16),
    ], pad=11, gap=7)
    c.save('04-public.png')


# ---------------------------------------------------------------- 5 商户
def screen_merchant():
    c = Canvas('商户', path='pages/merchant/index', idx='05/06')
    c.new()
    c.chrome()
    c.plain([
        e_title('商户核验', sz=12.5),
        e_body('请使用本地服务生成的商户测试令牌。', sz=9.5, lh=13),
        e_input('输入商户测试令牌', h=24, sz=10),
        e_btnrow([('核验并进入', 'primary'), ('返回首页', 'secondary')], h=24, sz=10.5),
    ], gap=6)
    c.plain([
        e_title('商户工作台', sz=16),
        e_body('绑定商户 M-0001', sz=10.5, gap=1),
        e_body('授权 查看本商户工单 · 提交商户诉求 · 协办任务', sz=10.5, gap=1),
        e_btnrow([('查看商户代表月报', 'secondary'), ('退出登录', 'text')], h=26, sz=11),
    ], gap=8)
    c.card([
        e_title('本商户工单', sz=13.5),
        e_btnrow([('刷新', 'text')], h=17, sz=10.5, gap=1),
        e_chip('全部状态 ▾', h=25, sz=10.5),
        e_body('若上一次提交结果未确认，请先在本列表核对是否已有该诉求，再提交新的申报。', sz=9.5, lh=14, gap=5),
        e_caserow('工单 CD-4F2A9C13B7D5E8F0A6C4B2D9E1F3A57', '已受理',
                  ['提交时间 2026-11-22 15:04']),
        e_caserow('工单 CD-8B31D7C5E0A24F69D8C3B1A7E5F2D04', '处理中',
                  ['提交时间 2026-11-20 09:12']),
    ], pad=11, gap=7)
    c.card([
        e_title('协办待办', sz=13.5),
        e_caserow('协办任务：核实沿街店招遮挡情况并反馈', '待提交',
                  ['CT-1F4A8C30B9D26E75807AC1F3E9B6D2', '办理期限 2026-11-25 18:00']),
    ], pad=11, gap=7)
    c.plain([e_meta('协办任务详情视图（提交送审）：')], gap=3)
    c.card([
        e_caserow('CT-1F4A8C30B9D26E75807AC1F3E9B6D2', '待提交',
                  ['必要地点 长堤风貌街 3 号门前', '办理期限 2026-11-25 18:00']),
        e_label('协办说明', sz=10, gap=2),
        e_area('填写现场情况与处理说明', h=30, sz=10),
        e_label('现场照片（选填，最多 3 张）', sz=10, gap=2),
        e_btnrow([('选择照片', 'secondary'), ('清除照片', 'secondary')], h=23, sz=10),
        e_body('已选 0 张，每张不超过 5 MiB，仅 JPEG、PNG 或 WebP，与说明一次提交；不选也可以只交文字。',
               sz=9, lh=12, gap=4),
        e_btn('提交送审', 'primary', h=25, sz=11),
    ], pad=11, gap=7)
    c.card([
        e_title('提交新诉求', sz=13.5),
        e_btnrow([('新建', 'text')], h=17, sz=10.5, gap=1),
        e_body('按提交权限填写并提交新诉求。可选照片最多 3 张（每张不超过 5 MiB，仅 JPEG/PNG/WebP），'
               '与正文一次提交；照片可留空。', sz=9.5, lh=13, gap=4),
        e_label('发生时间', sz=10, gap=2),
        e_btnrow([('2026-11-23 ▾', 'chip'), ('09:30 ▾', 'chip')], h=23, sz=10),
        e_label('发生地点', sz=10, gap=2),
        e_input('填写发生地点', h=23, sz=10),
        e_label('事项分类', sz=10, gap=2),
        e_input('填写事项分类', h=23, sz=10),
        e_label('诉求说明', sz=10, gap=2),
        e_area('填写问题经过与诉求', h=30, sz=10),
        e_label('建议处理部门（选填）', sz=10, gap=2),
        e_input('', h=23, sz=10),
        e_label('联系方式（选填）', sz=10, gap=2),
        e_input('便于回访的联系方式', h=23, sz=10),
        e_label('现场照片（选填，最多 3 张）', sz=10, gap=2),
        e_btnrow([('选择照片', 'secondary'), ('清除照片', 'secondary')], h=23, sz=10),
        e_body('已选 0 张。照片从本机临时文件读取，不访问任何网址；读取或校验失败时请求不会发出，可重新选择。',
               sz=9, lh=12, gap=4),
        e_btn('提交新诉求', 'primary', h=25, sz=11),
        e_btn('清空重填', 'secondary', h=25, sz=11),
    ], pad=11, gap=7)
    c.card([
        e_title('按工单号重取本人回执', sz=13),
        e_input('输入完整工单号', h=25, sz=10.5),
        e_btn('读取本人回执', 'secondary', h=25, sz=10.5),
    ], pad=11, gap=7)
    c.plain([e_meta('协办任务详情视图（提交送审）：')], gap=3)
    c.card([
        e_caserow('CT-1F4A8C30B9D26E75807AC1F3E9B6D2', '待提交',
                  ['必要地点 长堤风貌街 3 号门前', '办理期限 2026-11-25 18:00']),
        e_label('协办说明', sz=10, gap=2),
        e_area('填写现场情况与处理说明', h=30, sz=10),
        e_label('现场照片（选填，最多 3 张）', sz=10, gap=2),
        e_btnrow([('选择照片', 'secondary'), ('清除照片', 'secondary')], h=23, sz=10),
        e_body('已选 0 张，每张不超过 5 MiB，仅 JPEG、PNG 或 WebP，与说明一次提交；不选也可以只交文字。',
               sz=9, lh=12, gap=4),
        e_btn('提交送审', 'primary', h=25, sz=11),
    ], pad=11, gap=7)
    c.fade_bottom()
    c.save('05-merchant.png')


# ---------------------------------------------------------------- 6 工作台
def screen_staff():
    c = Canvas('管理方', path='pages/staff/index', idx='06/06')
    c.new()
    c.chrome()
    c.plain([
        e_title('管理方工作台', sz=13.5),
        e_body('请使用本地服务生成的工作人员测试令牌。', sz=9.5, lh=13),
        e_input('输入工作人员测试令牌', h=24, sz=10),
        e_btnrow([('核验并进入', 'primary'), ('返回首页', 'secondary')], h=24, sz=10.5),
    ], gap=6)
    c.plain([
        e_body('管理方工作台 · 值班人员 · zhangsan', sz=12.5, color=INK, lh=17, gap=1),
        e_btnrow([('查看街区月报', 'text'), ('打开协商整改台账', 'text'), ('退出登录', 'text')],
                 h=17, sz=10),
    ], gap=6)
    c.card([
        e_title('工单队列', sz=13),
        e_body('统计时间 2026-11-23 12:00 · 临期 48 小时', sz=9, lh=12, gap=5),
        e_queue([
            ('待受理', '12'), ('待分派', '8'), ('处理中', '34'), ('待复核', '6'),
            ('补办待审核', '3'), ('临期', '5'), ('超时', '2'),
        ]),
    ], pad=10, gap=6)
    c.card([
        e_title('工单列表', sz=13),
        e_chip('全部状态 ▾', h=24, sz=10),
        e_caserow('街面维护', '待受理', ['CD-4F2A9C13B7D5E8F0A6C4B2D9E1F3A57',
                                    '外部申报 · 环境卫生科 · 王五 · 截止 2026-11-24 18:00 · 临期']),
        e_caserow('设施损坏', '处理中', ['CD-8B31D7C5E0A24F69D8C3B1A7E5F2D04',
                                  '商户提交 · 市政科 · 李四 · 截止 2026-11-27 18:00']),
    ], pad=10, gap=6)
    c.plain([e_meta('工单详情视图：')], gap=2)
    c.card([
        e_caserow('街面维护', '处理中', ['CD-4F2A9C13B7D5E8F0A6C4B2D9E1F3A57']),
        e_kvrow('来源', '外部申报 · 第 1 轮', lsz=9.5, vsz=10.5, gap=3),
        e_kvrow('发生时间', '2026-11-23 09:00', lsz=9.5, vsz=10.5, gap=3),
        e_kvrow('发生地点', '长堤风貌街 12 号门前', lsz=9.5, vsz=10.5, gap=3),
        e_kvrow('主责部门', '环境卫生科 · 李四', lsz=9.5, vsz=10.5, gap=3),
        e_kvrow('办理截止', '2026-11-24 18:00', lsz=9.5, vsz=10.5, gap=3),
        e_kvrow('评价截止', '2026-11-27 18:00', lsz=9.5, vsz=10.5, gap=3),
        e_btn('查看联系方式', 'secondary', h=25, sz=10.5),
    ], pad=10, gap=6)
    c.plain([e_meta('以下 13 个动作按角色与工单状态出现（duty 值班人员 / handler 承办人 / supervisor 主管）：')], gap=2)
    c.card([
        e_title('办理操作', sz=13),
        e_btnrow([
            ('受理', 'secondary'), ('要求补材料', 'secondary'), ('不予受理', 'secondary'),
            ('分派', 'secondary'), ('转派', 'secondary'), ('接单', 'secondary'),
            ('提交办理结果', 'secondary'), ('退回承办', 'secondary'), ('发布文字反馈', 'secondary'),
            ('结案', 'secondary'), ('通过补办', 'secondary'), ('驳回补办', 'secondary'),
            ('发布图片反馈', 'secondary'),
        ], h=23, sz=9.5),
    ], pad=10, gap=6)
    c.card([
        e_title('重复投诉核对', sz=12.5),
        e_btnrow([('读取监督记录', 'text'), ('标注点位和分类', 'text'), ('撤销确认', 'text')],
                 h=17, sz=10),
        e_body('已确认重复 · 关联工单 CD-8B31D7C5E0A24F69D8C3B1A7E5F2D04', sz=9, lh=12, gap=2),
        e_body('候选工单（前 48 小时，最多 5 条）', sz=9, lh=12, gap=2),
    ], pad=10, gap=6)
    c.card([
        e_title('协办任务', sz=13),
        e_btnrow([('派发协办', 'text')], h=16, sz=10, gap=1),
        e_caserow('商户 M-0001', '待复核', [
            'CT-1F4A8C30B9D26E75807AC1F3E9B6D2 · 第 1 轮 · 协办截止 2026-11-25 18:00',
            '核实沿街店招遮挡情况并反馈',
        ]),
        e_btnrow([('通过协办', 'secondary'), ('退回补充', 'secondary'), ('撤回协办', 'secondary')],
                 h=23, sz=9.5),
    ], pad=10, gap=6)
    c.card([
        e_title('补办申请', sz=12.5),
        e_caserow('待审核', '', ['2026-11-22 20:10 · 申请前 待评价', '现场仍未清理完毕']),
        e_title('历轮反馈及评价', sz=12.5),
        e_caserow('第 1 轮', '', ['已组织清理并回复', '速度 / 效果 / 态度：4 / 4 / 5']),
        e_title('流转记录', sz=12.5),
        e_body('提交诉求　2026-11-23 09:31 · 游客', sz=9, lh=12, gap=2),
        e_body('受理　2026-11-23 10:05 · zhangsan', sz=9, lh=12, gap=2),
        e_body('分派　2026-11-23 10:40 · zhangsan', sz=9, lh=12, gap=2),
    ], pad=10, gap=6)
    c.fade_bottom()
    c.save('06-staff.png')


if __name__ == '__main__':
    screen_home()
    screen_submit()
    screen_mine()
    screen_public()
    screen_merchant()
    screen_staff()
