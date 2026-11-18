"""Render the README workflow illustration (Python 3 + Pillow).

Run: python docs/render_images.py
Set FLOWGATE_DOC_FONT and FLOWGATE_DOC_FONT_BOLD to Chinese font paths if needed.
UI screenshots are captured separately with docs/capture-ui.mjs.
"""
from pathlib import Path
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
FONT = os.environ.get("FLOWGATE_DOC_FONT", "C:/Windows/Fonts/msyh.ttc")
BOLD = os.environ.get("FLOWGATE_DOC_FONT_BOLD", "C:/Windows/Fonts/msyhbd.ttc")
BG, WHITE, INK = "#F3F6FC", "#FFFFFF", "#17243B"
MUTED, LINE, BLUE = "#53647D", "#DCE4F0", "#3866E8"
TEAL, AMBER, PURPLE = "#16837A", "#A86C13", "#7953CA"


def canvas(height):
    im = Image.new("RGB", (1600, height), BG)
    return im, ImageDraw.Draw(im)


def font(size, bold=False):
    return ImageFont.truetype(BOLD if bold else FONT, size)


def text(d, xy, value, size=28, fill=INK, bold=False):
    d.text(xy, value, font=font(size, bold), fill=fill)


def box(d, bounds, fill=WHITE, outline=LINE, radius=20):
    d.rounded_rectangle(bounds, radius=radius, fill=fill, outline=outline, width=2)


def arrow(d, points, fill=BLUE, width=4):
    d.line(points, fill=fill, width=width, joint="curve")
    x, y = points[-1]
    px, py = points[-2]
    if x > px:
        head = [(x, y), (x - 12, y - 8), (x - 12, y + 8)]
    elif x < px:
        head = [(x, y), (x + 12, y - 8), (x + 12, y + 8)]
    elif y < py:
        head = [(x, y), (x - 8, y + 12), (x + 8, y + 12)]
    else:
        head = [(x, y), (x - 8, y - 12), (x + 8, y - 12)]
    d.polygon(head, fill=fill)


def badge(d, xy, value, color=BLUE):
    x, y = xy
    d.ellipse((x, y, x + 42, y + 42), fill=color)
    d.text((x + 21, y + 20), value, anchor="mm", font=font(25, True), fill=WHITE)


def save(im, name):
    dest = ROOT / "images" / name
    dest.parent.mkdir(exist_ok=True)
    im.save(dest, optimize=True)
    print(f"{dest.name}: {im.width} x {im.height}")


def workflow():
    im, d = canvas(820)
    text(d, (64, 42), "让开发过程，每一步都看得见", 48, bold=True)
    text(d, (66, 114), "Agent 准备产物 → 你查看并确认 → 进入下一阶段", 28, MUTED)
    stages = [
        ("S1", "需求分析", BLUE, ["需求文档", "修改文件与验收标准"], "批准并冻结 scope"),
        ("S2", "开发", TEAL, ["代码变更", "开发规则与变更摘要"], "完成开发"),
        ("S3", "评审", AMBER, ["各角度的发现", "严重程度与文件位置"], "通过评审"),
        ("S4", "测试", PURPLE, ["通过 / 失败 / 未覆盖", "各方向验证结果"], "验收通过"),
    ]
    for i, (sid, name, color, items, action) in enumerate(stages):
        x = 64 + i * 376
        box(d, (x, 195, x + 344, 501))
        box(d, (x + 24, 221, x + 84, 263), fill=color, outline=color, radius=10)
        text(d, (x + 34, 222), sid, 27, WHITE, True)
        text(d, (x + 24, 285), name, 38, bold=True)
        for n, item in enumerate(items):
            text(d, (x + 24, 351 + n * 40), item, 25, MUTED)
        d.line((x + 24, 439, x + 320, 439), fill=LINE, width=2)
        text(d, (x + 24, 455), action, 26, color, True)
        if i < 3:
            arrow(d, [(x + 350, 309), (x + 368, 309)], MUTED, 3)
    arrow(d, [(987, 515), (987, 560), (611, 560), (611, 515)], TEAL)
    text(d, (678, 574), "发现问题，退回开发修复", 27, TEAL, True)
    box(d, (64, 650, 1536, 764), fill="#E8EEFD", outline="#D4DFFB")
    text(d, (90, 669), "scope = 本次允许修改的文件、功能与验收标准", 29, BLUE, True)
    text(d, (90, 716), "需要扩范围：回到需求分析，更新并重新批准。回退后已有代码保留。", 26, MUTED)
    save(im, "workflow.png")


if __name__ == "__main__":
    workflow()
