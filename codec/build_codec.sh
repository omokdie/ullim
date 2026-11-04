#!/bin/bash
# 울림 코덱 엔진(web/js/vendor/ullim-codec.wasm) 빌드 — FFmpeg n7.1.1 (LGPL 2.1+) 최소 구성 + codec/ullim_codec.c
#   준비물: clang 18 · wasm-ld · llvm-ar (Ubuntu 24.04 기본), 인터넷(GitHub)
#   bash codec/build_codec.sh [/tmp/wasm]
set -e
W=${1:-/tmp/wasm}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$W" && cd "$W"
[ -d wasi-sysroot-25.0 ] || { curl -sSL https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-25/wasi-sysroot-25.0.tar.gz | tar xz; }
[ -d libclang_rt.builtins-wasm32-wasi-25.0 ] || { curl -sSL https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-25/libclang_rt.builtins-wasm32-wasi-25.0.tar.gz | tar xz; }
if [ ! -d resdir ]; then cp -r "$(clang -print-resource-dir)" resdir; mkdir -p resdir/lib/wasi; cp libclang_rt.builtins-wasm32-wasi-25.0/libclang_rt.builtins-wasm32.a resdir/lib/wasi/; fi
[ -d ffmpeg ] || git clone -q --depth 1 -b n7.1.1 https://github.com/FFmpeg/FFmpeg ffmpeg
SYS=$W/wasi-sysroot-25.0; RES=$W/resdir
CC="clang --target=wasm32-wasi -resource-dir $RES --sysroot=$SYS"
DEC="alac,ape,wavpack,tta,dsd_lsbf,dsd_msbf,dsd_lsbf_planar,dsd_msbf_planar,wmav1,wmav2,wmapro,wmalossless,ac3,eac3,dca,mp1,mp2,mp3,flac,shorten,tak,mpc7,mpc8,truehd,mlp,\
pcm_s16be,pcm_s16le,pcm_s24be,pcm_s24le,pcm_s32be,pcm_s32le,pcm_f32be,pcm_f32le,pcm_f64be,pcm_f64le,pcm_s8,pcm_u8,pcm_alaw,pcm_mulaw,pcm_s24daud,\
adpcm_ima_wav,adpcm_ms,adpcm_ima_qt,adpcm_g726,adpcm_yamaha,gsm_ms"
DMX="mov,aiff,ape,wv,tta,dsf,iff,asf,ac3,eac3,dts,dtshd,mp3,wav,w64,caf,shorten,tak,mpc,mpc8,truehd,mlp,flac,matroska"
PRS="ac3,mpegaudio,dca,mlp,flac,tak"
if [ ! -f ff-out/lib/libavcodec.a ]; then
  cd ffmpeg
  ./configure --prefix="$W/ff-out" --enable-cross-compile --target-os=none --arch=wasm32 --cpu=generic \
    --cc="$CC" --ar=llvm-ar --ranlib=llvm-ranlib --nm=llvm-nm --strip=llvm-strip \
    --disable-asm --disable-inline-asm --disable-x86asm --disable-pthreads --disable-w32threads --disable-os2threads \
    --disable-network --disable-autodetect --disable-programs --disable-doc --disable-debug --disable-runtime-cpudetect \
    --disable-everything --disable-avdevice --disable-avfilter --disable-swscale --disable-postproc --disable-iconv \
    --enable-small --enable-swresample \
    --enable-decoder=$DEC --enable-demuxer=$DMX --enable-parser=$PRS --enable-encoder=flac \
    --extra-cflags="-D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN -fno-exceptions" \
    --extra-ldflags="-lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-mman" > configure.out
  make -j"$(nproc)" > make.out && make install > /dev/null
  cd ..
fi
$CC -O2 -mexec-model=reactor -I"$W/ff-out/include" "$HERE/ullim_codec.c" -L"$W/ff-out/lib" \
  -lavformat -lavcodec -lswresample -lavutil -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-mman \
  -Wl,-z,stack-size=1048576 -Wl,--strip-all -Wl,--gc-sections -o "$HERE/../web/js/vendor/ullim-codec.wasm"
ls -la "$HERE/../web/js/vendor/ullim-codec.wasm"
