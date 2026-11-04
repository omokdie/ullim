# 울림 코덱 엔진

브라우저 엔진(Chromium)이 직접 풀지 못하는 형식을 푸는 작은 디코더입니다.
[FFmpeg](https://ffmpeg.org) **n7.1.1** (LGPL 2.1 이상, 소스는 **고치지 않음**)을 필요한 부분만 골라 WebAssembly(wasm32-wasi)로 빌드하고,
`ullim_codec.c`(이 폴더, 울림 코드)로 감쌉니다. 결과물: `web/js/vendor/ullim-codec.wasm` (약 1.4MB, gzip 0.6MB).

## 하는 일

1. JS 가 파일 조각을 읽어 줍니다(`env.js_read`) — 브라우저가 JSPI(`WebAssembly.Suspending`)를 지원하면 필요한 조각만 비동기로,
   아니면 파일을 통째로 받아 동기로.
2. 열기 → 정보 · 태그 · 앨범아트(JSON) → 디코드 → 스테레오(5.1 등은 섞음) · 16/24비트 · (DSD 만) 리샘플 → **FLAC 프레임**(무손실, 4096 샘플).
3. `web/js/codec-worker.js` 가 FLAC 프레임을 fMP4(FLAC-in-ISOBMFF) 조각으로 싸고, `web/js/codec.js` 가 MediaSource 로 `<audio>` 에 넣습니다.

넣은 것: 디코더 alac · ape · wavpack · tta · dsd(4종) · wmav1/v2 · wmapro · wmalossless · ac3 · eac3 · dca · mp1/mp2/mp3 · flac · shorten · tak ·
mpc7/8 · truehd · mlp · pcm(각종) · adpcm(일부) · gsm_ms, 디먹서 mov · aiff · ape · wv · tta · dsf · iff(DFF) · asf · ac3 · eac3 · dts · dtshd · mp3 ·
wav · w64 · caf · shorten · tak · mpc · mpc8 · truehd · mlp · flac · matroska, 인코더 flac, libswresample. 네트워크 · 스레드 · asm 은 뺐습니다.

## 빌드

```bash
bash codec/build_codec.sh [/tmp/wasm]
```

Ubuntu 24.04 의 clang 18 · wasm-ld · llvm-ar 를 쓰고, wasi-sdk 25 의 sysroot · compiler-rt(builtins)를 GitHub 에서 받습니다.
FFmpeg 설정(`configure` 옵션)은 스크립트에 그대로 있습니다. 다른 FFmpeg(고친 것 포함)로 바꿔 빌드하려면 `[작업 폴더]/ffmpeg` 를 바꿔 넣고
`[작업 폴더]/ff-out` 을 지운 뒤 다시 실행하면 됩니다(LGPL 의 '다시 링크할 수 있게' 조건).

## 시험

```bash
python3 test/codec_test.py              # WavPack · TTA · ALAC · WMA · AIFF · AC3 · MP2 · CAF · 24bit/192kHz · 5.1 · DSD: 재생 · 길이 · 탐색 · 끝 · 주파수 · 태그
python3 test/codec_test.py --no-jspi    # 통째로 읽기 길
xvfb-run -a node test/electron_codec_test.js <electron> build/desktop-app
```

## 라이선스

- FFmpeg: LGPL 2.1 이상 — `web/js/vendor/LICENSE-ffmpeg-LGPL-2.1.txt`. 앱의 설정 → 정보 → **오픈소스 라이선스 보기**에도 있습니다.
  릴리스마다 FFmpeg 소스 묶음(`ffmpeg-n7.1.1-source.tar.xz`)을 같이 올립니다.
- `ullim_codec.c` · `build_codec.sh`: 울림 저장소와 같은 조건.
