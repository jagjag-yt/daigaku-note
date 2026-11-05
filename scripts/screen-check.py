# シミュレーターのスクショに、大学ノートの本棚の画面が出ているかを確かめる(標準ライブラリだけ)。
# 本棚の地の色(style.css の --shelf: #f6f7f9)が画面の一定の割合を占めていれば「出ている」とする。
# 真っ白・ホーム画面(アプリが終わった)では地の色が足りず、起動画面(スプラッシュ)は大きなアイコンのアクセント色が
# 多すぎるので、どちらも失敗になる。
# さらに、画面のプログラムが描く「新規」のカード(＋の印と文字がアクセント色 #2f5d9e)があることも見る。
# 本棚の地の色は HTML と CSS だけでも出るので、これがないと「プログラムが本棚を描いた」とは言えない。
# 右上の同期ボタン(これもアクセント色)を数えないよう、「新規」のある左半分だけを数える。
# 前提: ios-sim.sh が入れ直してから撮るので本棚は空。ノートがあると表紙の青(#2f5d9e)で上限を超える。
#
# 使い方: python3 scripts/screen-check.py 画像.bmp|画像.png
# 終了コード: 0 = 出ている / 1 = 出ていない / 2 = 画像を読めない(確かめられない)
import struct, sys, zlib

SHELF = (0xF6, 0xF7, 0xF9)
MIN_RATIO = 0.25
ACCENT = (0x2F, 0x5D, 0x9E)
MIN_ACCENT = 100  # 左半分のアクセント色の点の数(2 ピクセルおきに数える。CI の空の本棚で約 200〜600)
MAX_ACCENT = 5000  # 起動画面(大きなアイコン)は 4 万を超えるので、多すぎるのも本棚ではない


def read_bmp(data):
    off, = struct.unpack_from('<I', data, 10)
    hsize, w, h, planes, bits, comp = struct.unpack_from('<IiiHHI', data, 14)
    if bits not in (24, 32) or comp not in (0, 3):
        raise ValueError(f'この形式の BMP は読めません({bits}bit, 圧縮 {comp})')
    if comp == 3:  # 色の並びはビットマスクで決まる。BGR(A) の並びのときだけ読む
        masks = struct.unpack_from('<III', data, 54)
        if masks != (0x00FF0000, 0x0000FF00, 0x000000FF):
            raise ValueError(f'この色の並びの BMP は読めません(マスク {[hex(m) for m in masks]})')
    bpp, top_down, h = bits // 8, h < 0, abs(h)
    stride = (w * bpp + 3) & ~3
    if len(data) < off + stride * h:
        raise ValueError('BMP が途中で切れています')
    def px(x, y):
        row = y if top_down else h - 1 - y
        i = off + row * stride + x * bpp
        return data[i + 2], data[i + 1], data[i]  # BGR(A) → RGB
    return w, h, px


def read_png(data):
    pos, idat, ihdr = 8, b'', None
    while pos + 8 <= len(data):
        n, typ = struct.unpack_from('>I4s', data, pos)
        body = data[pos + 8:pos + 8 + n]
        if typ == b'IHDR': ihdr = struct.unpack('>IIBBBBB', body)
        elif typ == b'IDAT': idat += body
        elif typ == b'IEND': break
        pos += 12 + n
    if not ihdr: raise ValueError('PNG の見出しがありません')
    w, h, depth, ctype, _, _, interlace = ihdr
    if depth != 8 or ctype not in (2, 6) or interlace:
        raise ValueError(f'この形式の PNG は読めません(深さ {depth}, 色 {ctype}, インターレース {interlace})')
    bpp = 3 if ctype == 2 else 4
    raw, stride = zlib.decompress(idat), w * bpp
    rows, prev = [], bytearray(stride)
    for y in range(h):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        if f > 4: raise ValueError(f'PNG のフィルター {f} は読めません')
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
    return w, h, lambda x, y: tuple(rows[y][x * bpp:x * bpp + 3])


def main(path):
    try:
        data = open(path, 'rb').read()
        if data[:2] == b'BM': w, h, px = read_bmp(data)
        elif data[:8] == b'\x89PNG\r\n\x1a\n': w, h, px = read_png(data)
        else: raise ValueError('BMP でも PNG でもありません')
        # 上下 10%(時計・ホームバー)を除く。地の色は 4 ピクセル、アクセント色は 2 ピクセルおき(左半分だけ)
        total = hit = accent = 0
        for y in range(h // 10, h - h // 10, 2):
            for x in range(0, w, 2):
                c = px(x, y)
                if x < w // 2 and all(abs(a - b) <= 12 for a, b in zip(c, ACCENT)): accent += 1
                if x % 4 or (y - h // 10) % 4: continue
                total += 1
                hit += all(abs(a - b) <= 3 for a, b in zip(c, SHELF))
    except Exception as e:  # 壊れた・知らない形式の画像
        print(f'{path}: 画像を読めませんでした: {e}')
        return 2
    ratio = hit / max(total, 1)
    print(f'{path}: {w}x{h}、本棚の地の色の割合 {ratio:.0%}(必要 {MIN_RATIO:.0%} 以上)、'
          f'アクセント色の点 {accent}(必要 {MIN_ACCENT}〜{MAX_ACCENT})')
    return 0 if ratio >= MIN_RATIO and MIN_ACCENT <= accent <= MAX_ACCENT else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
