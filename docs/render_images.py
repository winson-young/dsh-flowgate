"""Render the two README illustrations (Python 3 + Pillow).

Run: python docs/render_images.py
Set FLOWGATE_DOC_FONT and FLOWGATE_DOC_FONT_BOLD to Chinese font paths if needed.
These are explanatory illustrations, not screenshots of a running DSH session.
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


def workbench():
    im, d = canvas(1060)
    text(d, (64, 35), "工作台怎么用？看进度、读产物、做决定", 43, bold=True)
    text(d, (66, 101), "S1 文档待确认时的布局示意 · 并非实机截图", 27, MUTED)
    box(d, (48, 162, 1552, 822), radius=22)
    d.line((49, 237, 1551, 237), fill=LINE, width=2)
    text(d, (78, 184), "对话", 27, MUTED)
    text(d, (190, 184), "流程工作台", 27, BLUE, True)
    d.line((190, 233, 336, 233), fill=BLUE, width=5)
    text(d, (1300, 185), "小功能快速开发", 24, MUTED)
    # Left navigation: stages show progress, not links that jump stages.
    badge(d, (75, 265), "1")
    text(d, (130, 269), "当前阶段", 28, bold=True)
    for i, (sid, name, state) in enumerate([
        ("S1", "需求分析", "等待确认"), ("S2", "开发", "未开始"),
        ("S3", "评审", "未开始"), ("S4", "测试", "未开始")
    ]):
        y = 332 + i * 101
        box(d, (74, y, 304, y + 84), fill="#EDF2FF" if i == 0 else WHITE,
            outline="#B7CAF9" if i == 0 else LINE, radius=12)
        text(d, (91, y + 11), f"{sid}  {name}", 25, BLUE if i == 0 else INK, True)
        text(d, (91, y + 47), state, 21, MUTED)
    # Main document area.
    badge(d, (347, 265), "2")
    text(d, (402, 269), "需求文档与修改范围", 28, bold=True)
    box(d, (346, 332, 1100, 776), radius=14)
    text(d, (376, 355), "示例需求：会话超时后重新认证", 30, bold=True)
    text(d, (376, 414), "目标", 25, BLUE, True)
    text(d, (376, 455), "超过 30 分钟未活动时，提供重新认证入口。", 25)
    text(d, (376, 516), "本次修改范围", 25, BLUE, True)
    text(d, (376, 557), "src/auth.ts     src/session.ts", 24, MUTED)
    text(d, (376, 618), "验收标准", 25, BLUE, True)
    text(d, (376, 659), "会话超时 → 接口返回 401 → 引导重新认证", 25)
    text(d, (376, 721), "先核对目标、文件清单和验收条件，再批准。", 23, MUTED)
    # Gate first, stage settings second, as in the actual client.
    badge(d, (1142, 265), "3")
    text(d, (1197, 269), "出口门禁", 28, bold=True)
    box(d, (1142, 332, 1524, 571), radius=14)
    text(d, (1164, 352), "需求文档已提交，等待你确认", 23, MUTED)
    box(d, (1164, 403, 1502, 461), fill=BLUE, outline=BLUE, radius=12)
    text(d, (1190, 415), "批准并冻结 scope", 28, WHITE, True)
    box(d, (1164, 481, 1502, 536), radius=12)
    text(d, (1271, 493), "修改需求", 26)
    box(d, (1142, 595, 1524, 776), radius=14)
    text(d, (1164, 615), "阶段设置", 27, bold=True)
    text(d, (1164, 662), "开发规则 · 评审角度", 25, MUTED)
    text(d, (1164, 703), "测试方向 · 档位", 25, MUTED)
    # Parallel captions keep the image readable at README width.
    for i, (title, detail) in enumerate([
        ("看进度", "阶段按顺序推进，不能点击跳转"),
        ("读产物", "先看内容，再判断是否满足需求"),
        ("做决定", "确认、退回或跳过当前门禁")
    ]):
        x = 64 + i * 504
        badge(d, (x, 864), str(i + 1))
        text(d, (x + 57, 865), title, 30, bold=True)
        text(d, (x, 923), detail, 25, MUTED)
    text(d, (64, 995), "按钮显示“准备中”？回到对话，让 Agent 继续当前阶段并提交产物。", 26, MUTED)
    save(im, "workbench.png")


if __name__ == "__main__":
    workflow()
    workbench()
