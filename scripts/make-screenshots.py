"""Turns build/screens.json into the two images the README shows.

The text and the spans come from the real renderers, the colours from the real
manifest; this only draws them the way the editor would: one monospace glyph per
column, one theme colour per span, a quiet hint column on the right.
"""
import json
import pathlib
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCREENS = ROOT / "build" / "screens.json"
OUT = ROOT / "media" / "demo"

FONT = "C:/Windows/Fonts/consola.ttf"
FONT_UI = "C:/Windows/Fonts/segoeui.ttf"
SIZE = 14
UI_SIZE = 12
LINE_HEIGHT = 20
PAD_LEFT = 18
PAD_TOP = 14
PAD_RIGHT = 18
PAD_BOTTOM = 14
TAB_HEIGHT = 34
RADIUS = 0

TAB_BG = (0x25, 0x25, 0x26)
TAB_TEXT = (0x9d, 0x9d, 0x9d)
TAB_ACTIVE_TEXT = (0xff, 0xff, 0xff)
TAB_ACTIVE_UNDERLINE = (0x3c, 0x3c, 0x3c)
CARET = (0xae, 0xaf, 0xad)
LABELS = {"status": "githelm-status", "log": "githelm-log"}


def load(path):
    try:
        return ImageFont.truetype(path, SIZE)
    except OSError:
        return ImageFont.load_default()


def main():
    data = json.loads(SCREENS.read_text(encoding="utf-8"))
    font = load(FONT)
    ui = load(FONT_UI)
    advance = font.getlength("M" * 40) / 40

    for screen in data["screens"]:
        lines = screen["lines"]
        columns = max(len(line) for line in lines)
        width = int(PAD_LEFT + columns * advance + PAD_RIGHT)
        height = int(TAB_HEIGHT + PAD_TOP + len(lines) * LINE_HEIGHT + PAD_BOTTOM)
        image = Image.new("RGB", (width, height), (0x1e, 0x1e, 0x1e))
        draw = ImageDraw.Draw(image)

        # The tab strip, so the image reads as an editor and not as a text dump.
        draw.rectangle([0, 0, width, TAB_HEIGHT - 1], fill=TAB_BG)
        label = LABELS.get(screen["name"], screen["name"])
        tab_width = int(ui.getlength(label) + 44)
        draw.rectangle([0, 0, tab_width, TAB_HEIGHT - 1], fill=(0x1e, 0x1e, 0x1e))
        draw.line([0, TAB_HEIGHT - 2, tab_width, TAB_HEIGHT - 2], fill=TAB_ACTIVE_UNDERLINE, width=2)
        draw.text((22, TAB_HEIGHT // 2), label, font=ui, fill=TAB_ACTIVE_TEXT, anchor="lm")
        draw.text((width - 16, TAB_HEIGHT // 2), "UTF-8", font=ui, fill=TAB_TEXT, anchor="rm")

        by_line = {}
        for span in screen["spans"]:
            by_line.setdefault(span["line"], []).append(span)

        foreground = tuple(int(data["foreground"][i : i + 2], 16) for i in (1, 3, 5))
        for index, text in enumerate(lines):
            y = TAB_HEIGHT + PAD_TOP + index * LINE_HEIGHT
            cursor = 0
            for span in sorted(by_line.get(index, []), key=lambda item: item["start"]):
                start = max(span["start"], cursor)
                end = min(span["end"], len(text))
                if end <= start:
                    continue
                colour_id = data["kinds"].get(span["kind"])
                value = data["palette"].get(colour_id, data["foreground"])
                colour = tuple(int(value[i : i + 2], 16) for i in (1, 3, 5))
                draw.text((PAD_LEFT + start * advance, y), text[start:end], font=font, fill=colour)
                cursor = end
            if cursor < len(text):
                draw.text((PAD_LEFT + cursor * advance, y), text[cursor:], font=font, fill=foreground)

        # A caret on the first line, the way the buffer opens.
        caret_x = PAD_LEFT + len(lines[0]) * advance + 2
        draw.rectangle([caret_x, TAB_HEIGHT + PAD_TOP + 2, caret_x + 1, TAB_HEIGHT + PAD_TOP + LINE_HEIGHT - 3], fill=CARET)

        OUT.mkdir(parents=True, exist_ok=True)
        target = OUT / f"{screen['name']}.png"
        image.save(target, optimize=True)
        print(f"{target.relative_to(ROOT)}: {width}x{height}, {target.stat().st_size // 1024} KB")


if __name__ == "__main__":
    sys.exit(main())
