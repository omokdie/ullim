"""
Windows .exe 리소스를 제자리(in-place)에서 바꾸는 작은 도구.
 - 아이콘(RT_ICON / RT_GROUP_ICON): 기존 항목과 같은 크기(또는 더 작게)로 교체
 - 버전 정보(RT_VERSION) 문자열: 기존 칸 안에서 교체
 - PE 체크섬 재계산
섹션 크기를 바꾸지 않으므로 실행 파일 구조가 그대로 유지된다.
"""
import io, struct, sys
from PIL import Image

RT_ICON, RT_GROUP_ICON, RT_VERSION = 3, 14, 16


class PE:
    def __init__(self, data):
        self.d = bytearray(data)
        d = self.d
        self.pe = struct.unpack_from('<I', d, 0x3c)[0]
        assert d[self.pe:self.pe + 4] == b'PE\0\0'
        nsec = struct.unpack_from('<H', d, self.pe + 6)[0]
        optsz = struct.unpack_from('<H', d, self.pe + 20)[0]
        self.opt = self.pe + 24
        magic = struct.unpack_from('<H', d, self.opt)[0]
        self.dd = self.opt + (112 if magic == 0x20b else 96)
        self.checksum_off = self.opt + 64
        self.secs = []
        so = self.opt + optsz
        for i in range(nsec):
            o = so + 40 * i
            vsz, va, rsz, rptr = struct.unpack_from('<IIII', d, o + 8)
            self.secs.append((va, max(vsz, rsz), rptr))
        self.rsrc_rva, self.rsrc_size = struct.unpack_from('<II', d, self.dd + 8 * 2)
        self.rsrc_off = self.rva2off(self.rsrc_rva)

    def rva2off(self, rva):
        for va, sz, rptr in self.secs:
            if va <= rva < va + sz:
                return rva - va + rptr
        raise ValueError('rva not mapped %#x' % rva)

    def resources(self):
        """yield (type, name, lang, data_entry_file_offset, data_rva, size)"""
        d, base = self.d, self.rsrc_off

        def entries(dir_off):
            n_named, n_id = struct.unpack_from('<HH', d, base + dir_off + 12)
            for i in range(n_named + n_id):
                name, off = struct.unpack_from('<II', d, base + dir_off + 16 + 8 * i)
                yield name, off

        out = []
        for t, toff in entries(0):
            if not toff & 0x80000000:
                continue
            for n, noff in entries(toff & 0x7fffffff):
                if not noff & 0x80000000:
                    continue
                for l, loff in entries(noff & 0x7fffffff):
                    if loff & 0x80000000:
                        continue
                    de = base + loff
                    rva, size = struct.unpack_from('<II', d, de)
                    out.append((t, n, l, de, rva, size))
        return out

    def checksum(self):
        d = self.d
        struct.pack_into('<I', d, self.checksum_off, 0)
        s = 0
        n = len(d)
        if n % 2:
            d.append(0)
        for (w,) in struct.iter_unpack('<H', bytes(d[:len(d) - (len(d) % 2)])):
            s += w
            s = (s & 0xffff) + (s >> 16)
        s = (s & 0xffff) + (s >> 16)
        s += n
        struct.pack_into('<I', d, self.checksum_off, s & 0xffffffff)
        if len(d) != n:
            del d[n:]


def pick(img, w):
    return img(w) if callable(img) else img


def dib_icon(img, w, h, bpp):
    """32bpp BITMAPINFOHEADER icon image (XOR BGRA bottom-up + 1bpp AND mask)."""
    assert bpp == 32
    im = pick(img, w).convert('RGBA').resize((w, h), Image.LANCZOS)
    px = im.tobytes('raw', 'BGRA')
    rows = [px[y * w * 4:(y + 1) * w * 4] for y in range(h)][::-1]
    xor = b''.join(rows)
    mask_row = ((w + 31) // 32) * 4
    andm = bytearray()
    a = im.split()[3].tobytes()
    for y in range(h - 1, -1, -1):
        row = bytearray(mask_row)
        for x in range(w):
            if a[y * w + x] < 128:
                row[x // 8] |= 0x80 >> (x % 8)
        andm += row
    hdr = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0, len(xor) + len(andm), 0, 0, 0, 0)
    return hdr + xor + bytes(andm)


def png_icon(img, w, h, limit):
    im = pick(img, w).convert('RGBA').resize((w, h), Image.LANCZOS)
    for colors in (None, 256, 128, 64):
        b = io.BytesIO()
        (im if colors is None else im.quantize(colors=colors, method=Image.FASTOCTREE)).save(b, 'PNG', optimize=True)
        if len(b.getvalue()) <= limit:
            return b.getvalue()
    raise ValueError('png too big for slot %dx%d (%d bytes)' % (w, h, limit))


def patch_icons(pe, src_img):
    d = pe.d
    res = pe.resources()
    icons = {n: (de, rva, size) for t, n, l, de, rva, size in res if t == RT_ICON}
    groups = [(n, de, rva, size) for t, n, l, de, rva, size in res if t == RT_GROUP_ICON]
    done = 0
    for gname, gde, grva, gsize in groups:
        go = pe.rva2off(grva)
        _, _, count = struct.unpack_from('<HHH', d, go)
        for i in range(count):
            eo = go + 6 + 14 * i
            bw, bh, cc, _, planes, bpp, nbytes, nid = struct.unpack_from('<BBBBHHIH', d, eo)
            de, rva, size = icons[nid]
            off = pe.rva2off(rva)
            old = bytes(d[off:off + size])
            if old[:8] == b'\x89PNG\r\n\x1a\n':
                w, h = struct.unpack('>II', old[16:24])
                new = png_icon(src_img, w, h, size)
            else:
                hsz, w, h2, _, obpp = struct.unpack_from('<IiiHH', old, 0)
                h = h2 // 2
                if obpp != 32:
                    print(f'  skip icon {nid}: {w}x{h} {obpp}bpp')
                    continue
                new = dib_icon(src_img, w, h, 32)
                if len(new) > size:
                    raise ValueError('dib too big')
            d[off:off + size] = new + b'\0' * (size - len(new))
            struct.pack_into('<I', d, de + 4, len(new))      # data entry size
            struct.pack_into('<I', d, eo + 8, len(new))      # group bytesInRes
            print(f'  icon {nid}: {w}x{h} {"png" if new[:4] == bytes([0x89, 80, 78, 71]) else "dib"} {len(new)}/{size} bytes')
            done += 1
    return done


def patch_version(pe, strings, numeric=None):
    d = pe.d
    for t, n, l, de, rva, size in pe.resources():
        if t != RT_VERSION:
            continue
        off = pe.rva2off(rva)
        blob = d[off:off + size]
        if numeric:
            sig = blob.find(struct.pack('<I', 0xFEEF04BD))
            if sig >= 0:
                a, b, c, e = numeric
                ms, ls = (a << 16) | b, (c << 16) | e
                struct.pack_into('<IIII', blob, sig + 8, ms, ls, ms, ls)
        for key, val in strings.items():
            k = (key + '\0').encode('utf-16le')
            pos = blob.find(k)
            while pos >= 0:
                # String header is 6 bytes before key: wLength, wValueLength, wType
                hdr = pos - 6
                wlen, wvlen, wtype = struct.unpack_from('<HHH', blob, hdr)
                if wtype == 1 and wvlen > 0:
                    voff = pos + len(k)
                    voff += (-voff) % 4
                    cap = wvlen * 2
                    nv = (val + '\0').encode('utf-16le')
                    if len(nv) > cap:
                        raise ValueError(f'{key}: "{val}" too long (max {cap // 2 - 1} chars)')
                    blob[voff:voff + cap] = nv + b'\0' * (cap - len(nv))
                    struct.pack_into('<H', blob, hdr + 2, len(nv) // 2)
                    print(f'  version {key} = {val}')
                    break
                pos = blob.find(k, pos + 2)
        d[off:off + size] = blob


if __name__ == '__main__':
    exe, icon_png = sys.argv[1], sys.argv[2]
    data = open(exe, 'rb').read()
    pe = PE(data)
    import os
    big = Image.open(icon_png)
    adir = os.path.dirname(icon_png)
    src = lambda w: Image.open(os.path.join(adir, f'exe_{w}.png')) if os.path.exists(os.path.join(adir, f'exe_{w}.png')) else big
    n = patch_icons(pe, src)
    patch_version(pe, {
        'CompanyName': 'Ullim',
        'FileDescription': '울림',
        'ProductName': '울림',
        'InternalName': 'Ullim',
        'OriginalFilename': 'Ullim.exe',
        'LegalCopyright': '울림 · Electron(MIT) 기반',
        'FileVersion': '1.2.1',
        'ProductVersion': '1.2.1',
    }, numeric=(1, 2, 1, 0))
    pe.checksum()
    open(exe, 'wb').write(pe.d)
    print('patched icons:', n)
