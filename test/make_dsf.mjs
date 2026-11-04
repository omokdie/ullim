// 시험용 DSF (DSD64, 스테레오) 만들기: node test/make_dsf.mjs 출력.dsf [초]
// 시험용 DSF (DSD64, 스테레오): 왼쪽 1kHz, 오른쪽 440Hz 사인을 2차 시그마-델타로 1비트화
import fs from 'fs';
const fs_ = 2822400, secs = +(process.argv[3] || 3), n = fs_ * secs, blk = 4096;
const nbytes = Math.ceil(n / 8 / blk) * blk;
const chans = [1000, 440].map(f => {
  const out = new Uint8Array(nbytes); let i1 = 0, i2 = 0, y = 0;
  for (let i = 0; i < n; i++) {
    const x = 0.5 * Math.sin(2 * Math.PI * f * i / fs_);
    i1 += x - y; i2 += i1 - y; y = i2 >= 0 ? 1 : -1;
    if (y > 0) out[i >> 3] |= 1 << (i & 7);            // LSB 먼저
  }
  for (let i = Math.ceil(n / 8); i < nbytes; i++) out[i] = 0x69;   // 무음 패턴
  return out;
});
const data = Buffer.alloc(nbytes * 2);
for (let b = 0; b < nbytes / blk; b++) for (let c = 0; c < 2; c++) data.set(chans[c].subarray(b * blk, (b + 1) * blk), (b * 2 + c) * blk);
const hdr = Buffer.alloc(28 + 52 + 12);
let o = 0; const w4 = s => { hdr.write(s, o, 'ascii'); o += 4; }, u32 = v => { hdr.writeUInt32LE(v, o); o += 4; }, u64 = v => { hdr.writeBigUInt64LE(BigInt(v), o); o += 8; };
const total = hdr.length + data.length;
w4('DSD '); u64(28); u64(total); u64(0);
w4('fmt '); u64(52); u32(1); u32(0); u32(2); u32(2); u32(fs_); u32(1); u64(n); u32(blk); u32(0);
w4('data'); u64(12 + data.length);
fs.writeFileSync(process.argv[2], Buffer.concat([hdr, data]));
