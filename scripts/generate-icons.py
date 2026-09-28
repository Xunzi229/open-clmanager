"""从用户提供的原图生成桌面程序及网页图标。依赖 Pillow。"""

from collections import deque
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "desktop" / "assets"
source = Image.open(ASSETS / "source.png").convert("RGBA")
width, height = source.size
if width != height or width < 512:
    raise ValueError("图标原图必须是至少 512px 的正方形")

# 原图的图标外侧为近黑色；只清除与画布边缘连通的背景。
pixels = source.load()
seen = bytearray(width * height)
queue = deque()

def add(x, y):
    index = y * width + x
    if seen[index] or max(pixels[x, y][:3]) >= 15:
        return
    seen[index] = 1
    queue.append((x, y))

for x in range(width):
    add(x, 0)
    add(x, height - 1)
for y in range(height):
    add(0, y)
    add(width - 1, y)
while queue:
    x, y = queue.popleft()
    if x: add(x - 1, y)
    if x + 1 < width: add(x + 1, y)
    if y: add(x, y - 1)
    if y + 1 < height: add(x, y + 1)
for index, outside in enumerate(seen):
    if outside:
        pixels[index % width, index // width] = (0, 0, 0, 0)

icon = source.resize((1024, 1024), Image.Resampling.LANCZOS)
icon.save(ASSETS / "icon.png", optimize=True)
icon.save(ROOT / "public" / "icon.png", optimize=True)
icon.save(ASSETS / "icon.ico", format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
icon.save(ASSETS / "icon.icns", format="ICNS")
linux = ASSETS / "linux"
linux.mkdir(exist_ok=True)
for size in (16, 24, 32, 48, 64, 128, 256, 512, 1024):
    icon.resize((size, size), Image.Resampling.LANCZOS).save(linux / f"{size}x{size}.png", optimize=True)
print("生成 Windows ICO、macOS ICNS、Linux PNG 和界面图标")
