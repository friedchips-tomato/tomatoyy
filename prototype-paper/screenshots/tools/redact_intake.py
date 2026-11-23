# -*- coding: utf-8 -*-
"""生成 intake 组「脱敏展示副本」。

原始证据不入库。本脚本不读取仓库内的任何原始证据，必须通过 --evidence-dir 显式传入
一个位于仓库之外、由本机用户控制的输入目录（例如外部留证目录的副本）：

  * 从 <evidence-dir>/*.original.png（原始证据，字节不变）读取；
  * 在凭证值区域画不透明遮挡条（保留字段名、写明「已脱敏」）；
  * 输出到 intake/ 下的公开展示副本，供索引、答辩素材与 link/ 联动图使用。

脚本可重复运行，输出始终由仓库外的证据原图重新生成。

用法（仓库根目录下执行）：
  python prototype-paper/screenshots/tools/redact_intake.py --evidence-dir <仓库外证据目录>
"""
import argparse
import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.abspath(os.path.join(HERE, '..'))
INTAKE = os.path.join(SHOTS, 'intake')
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))

FONT = r'C:\Windows\Fonts\msyh.ttc'
PAGE_BG = (246, 239, 224)   # #F6EFE0 页面纸色
CARD_BG = (251, 247, 236)   # #FBF7EC 纸卡色
BAR_BG = (232, 223, 202)    # #E8DFCA 遮挡条底色
BAR_LINE = (178, 58, 42)    # #B23A2A 朱红描边
BAR_TEXT = (111, 101, 86)   # #6F6556 说明字色

# 每张图：目标文件、证据文件、[(遮挡框, 说明文字, 框所在底色)]
REDACTIONS = [
    (
        '01-receipt.png',
        '01-receipt.original.png',
        [
            ((18, 302, 360, 352), '工单编号：〔已脱敏〕', PAGE_BG),
            ((18, 371, 360, 397), '公开查询码：〔已脱敏〕', PAGE_BG),
            ((18, 412, 360, 465), '本人私密凭证：〔已脱敏，不展示〕', PAGE_BG),
            ((38, 726, 350, 768), '工单编号：〔已脱敏〕', CARD_BG),
        ],
    ),
    (
        '02-panel-after-refresh.png',
        '02-panel-after-refresh.original.png',
        [
            ((38, 637, 350, 678), '工单编号：〔已脱敏〕', CARD_BG),
        ],
    ),
    (
        '04-upstream-down.png',
        '04-upstream-down.original.png',
        [
            ((38, 472, 350, 513), '工单编号：〔已脱敏〕', CARD_BG),
        ],
    ),
]


def draw_bar(d, box, text, bg):
    x0, y0, x1, y1 = box
    d.rectangle([x0, y0, x1, y1], fill=BAR_BG, outline=BAR_LINE, width=1)
    f = ImageFont.truetype(FONT, 13)
    bbox = f.getbbox(text)
    th = bbox[3] - bbox[1]
    ty = y0 + (y1 - y0 - th) / 2 - bbox[1]
    d.text((x0 + 10, ty), text, font=f, fill=BAR_TEXT)


def is_within(child, parent):
    """child 是否位于 parent 之内（含相等），按 realpath 判断。"""
    try:
        child_r = os.path.realpath(child)
        parent_r = os.path.realpath(parent)
        return os.path.commonpath([child_r, parent_r]) == parent_r
    except ValueError:
        # 跨盘符等无法比较的情况
        return False


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description='从仓库外的原始证据目录生成 intake 脱敏展示副本。')
    parser.add_argument(
        '--evidence-dir', required=True,
        help='原始截图所在的仓库外目录（必须位于仓库之外，由本机用户控制）')
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    evidence_dir = os.path.abspath(args.evidence_dir)

    if is_within(evidence_dir, ROOT):
        raise SystemExit(
            '拒绝执行：--evidence-dir 必须位于仓库之外，不接受仓库内路径：%s'
            % evidence_dir)
    if not os.path.isdir(evidence_dir):
        raise SystemExit('证据目录不存在：%s' % evidence_dir)

    for target, evidence, bars in REDACTIONS:
        src = os.path.join(evidence_dir, evidence)
        dst = os.path.join(INTAKE, target)
        if not os.path.isfile(src):
            raise SystemExit('缺少原始证据：%s' % src)
        im = Image.open(src).convert('RGB')
        d = ImageDraw.Draw(im)
        for box, text, bg in bars:
            draw_bar(d, box, text, bg)
        im.save(dst, 'PNG', optimize=True)
        print('已生成脱敏展示副本：prototype-paper/screenshots/intake/%s  （证据：仓库外 %s）'
              % (target, evidence))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
