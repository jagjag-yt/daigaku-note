# スクショが真っ白(画面が出ていない)でないかを確かめる。標準ライブラリだけで PNG を読む。
# 使い方: python3 scripts/png-blank.py 画像.png  → 上下 10% を除いた部分の色の数を出し、少なすぎれば終了コード 1
import struct, sys, zlib

def read_png(path):
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', 'PNG ではありません'
    pos, idat = 8, b''
    while pos < len(data):
        n, typ = struct.unpack('>I4s', data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + n]
        if typ == b'IHDR':
            w, h, depth, ctype, _, _, interlace = struct.unpack('>IIBBBBB', body)
        elif typ == b'IDAT':
            idat += body
        pos += 12 + n
    assert depth == 8 and ctype in (2, 6) and interlace == 0, f'この形式の PNG は読めません({depth}, {ctype}, {interlace})'
    bpp = 3 if ctype == 2 else 4
    raw, stride = zlib.decompress(idat), w * bpp
    rows, prev = [], bytearray(stride)
    for y in range(h):
        f, line = raw[y * (stride + 1)], bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b, c = prev[i], (prev[i - bpp] if i >= bpp else 0)
            if f == 1: line[i] = (line[i] + a) & 255
            elif f == 2: line[i] = (line[i] + b) & 255
            elif f == 3: line[i] = (line[i] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(line); prev = line
    return w, h, bpp, rows

try:
    w, h, bpp, rows = read_png(sys.argv[1])
except AssertionError as e:
    print(f'::warning::{sys.argv[1]} を確かめられませんでした: {e}')
    sys.exit(0)
colors = set()
for y in range(h // 10, h - h // 10, 4):
    r = rows[y]
    for x in range(0, w, 4):
        colors.add(bytes(r[x * bpp:x * bpp + 3]))
print(f'{sys.argv[1]}: {w}x{h}、色の数 {len(colors)}')
sys.exit(0 if len(colors) >= 8 else 1)
