/* 울림 코덱 엔진 — FFmpeg(LGPL 2.1+) 를 감싼 작은 디코더 (wasm32-wasi)
 *
 * 브라우저 엔진(Chromium)이 직접 못 푸는 형식(DSD · APE · WavPack · ALAC · AIFF · WMA · TTA · AC3 · DTS …)을 푼다.
 *  - 파일 읽기는 JS 가 맡는다: env.js_read(위치, 버퍼, 크기) — JS 쪽이 비동기면 JSPI 로 기다림.
 *  - 열기 → 정보 · 태그 · 앨범아트(JSON) → 디코드 → 스테레오 · 16/24비트(원본 비트) · 필요할 때만 리샘플(DSD)
 *    → FLAC 프레임(무손실)으로 묶어 돌려준다. JS 는 이걸 fMP4 조각으로 싸서 MediaSource 로 <audio> 에 넣는다.
 *    그래서 재생 · 탐색 · 속도(음정 유지) · 음장 효과가 다른 형식과 똑같이 동작한다.
 *  - 원본이 16비트면 16비트 그대로, 그 밖(24비트 · 32비트 · 실수 · 손실 압축 · DSD)은 24비트 무손실로.
 *  - DSD: FFmpeg 의 DSD→PCM 변환(352.8kHz 실수) 뒤 1/4 로 내려 88.2kHz(DSD64) · 176.4kHz(DSD128↑, 상한 안에서).
 */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <math.h>
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libswresample/swresample.h>
#include <libavutil/opt.h>
#include <libavutil/channel_layout.h>

#define EXPORT(name) __attribute__((export_name(#name)))
__attribute__((import_module("env"), import_name("js_read"))) extern int js_read(double pos, uint8_t *buf, int size);

#define FRAME 4096                 /* FLAC 프레임 길이 (샘플) */

typedef struct UL {
  double size, pos;
  AVIOContext *avio;
  AVFormatContext *fmt;
  int si;
  AVStream *st;
  AVCodecContext *dec;
  AVPacket *pkt;
  AVFrame *frm;
  SwrContext *swr;
  AVCodecContext *enc;
  AVFrame *ef;
  int ef_fill;
  AVPacket *epkt;
  int in_rate, out_rate, out_ch, out_bits, bps;   /* bps = 출력 한 샘플(모든 채널) 바이트 */
  int dsd;
  int64_t out_pts;
  double seek_to;
  int eof_in, done;
  uint8_t *tmp; int tmp_cap;
  uint8_t *ob; int ob_len, ob_cap;
  int32_t *sz, *du; int n, ncap;
  double first_pts;
  char info[4096];
  uint8_t si_box[34];
} UL;

/* ---------- JS 가 주는 파일 읽기 ---------- */
static int io_read(void *op, uint8_t *buf, int size) {
  UL *u = op;
  if (u->pos >= u->size) return AVERROR_EOF;
  if (u->pos + size > u->size) size = (int)(u->size - u->pos);
  int n = js_read(u->pos, buf, size);
  if (n < 0) return AVERROR(EIO);
  if (n == 0) return AVERROR_EOF;
  u->pos += n;
  return n;
}
static int64_t io_seek(void *op, int64_t off, int whence) {
  UL *u = op;
  if (whence & AVSEEK_SIZE) return (int64_t)u->size;
  whence &= ~AVSEEK_FORCE;
  double np;
  if (whence == SEEK_SET) np = (double)off;
  else if (whence == SEEK_CUR) np = u->pos + (double)off;
  else if (whence == SEEK_END) np = u->size + (double)off;
  else return -1;
  if (np < 0) return -1;
  u->pos = np;
  return (int64_t)np;
}

/* ---------- 정보 JSON ---------- */
static void jput(UL *u, int *len, const char *s) {
  int cap = (int)sizeof(u->info) - 8;
  for (; *s && *len < cap; s++) u->info[(*len)++] = *s;
  u->info[*len] = 0;
}
static void jstr(UL *u, int *len, const char *key, const char *v) {
  if (!v || !*v) return;
  char k[64]; snprintf(k, sizeof k, ",\"%s\":\"", key); jput(u, len, k);
  int cap = (int)sizeof(u->info) - 16;
  for (const unsigned char *p = (const unsigned char *)v; *p && *len < cap; p++) {
    char e[8];
    if (*p == '"' || *p == '\\') { e[0] = '\\'; e[1] = (char)*p; e[2] = 0; }
    else if (*p < 0x20) snprintf(e, sizeof e, "\\u%04x", *p);
    else { e[0] = (char)*p; e[1] = 0; }
    jput(u, len, e);
  }
  jput(u, len, "\"");
}
static const char *meta(UL *u, const char *k) {
  AVDictionaryEntry *e = av_dict_get(u->fmt->metadata, k, NULL, 0);
  if (!e && u->st) e = av_dict_get(u->st->metadata, k, NULL, 0);
  return e ? e->value : NULL;
}

/** 파일 열기. 성공하면 UL*, 실패하면 0 */
EXPORT(ul_open) UL *ul_open(double size) {
  av_log_set_level(AV_LOG_ERROR);
  UL *u = calloc(1, sizeof(UL));
  if (!u) return 0;
  u->size = size; u->seek_to = -1;
  uint8_t *iobuf = av_malloc(65536);
  u->avio = avio_alloc_context(iobuf, 65536, 0, u, io_read, NULL, io_seek);
  u->fmt = avformat_alloc_context();
  u->fmt->pb = u->avio;
  u->fmt->flags |= AVFMT_FLAG_CUSTOM_IO;
  if (avformat_open_input(&u->fmt, NULL, NULL, NULL) < 0) { u->fmt = NULL; goto fail; }
  u->fmt->probesize = 1 << 20;
  if (avformat_find_stream_info(u->fmt, NULL) < 0) goto fail;
  u->si = av_find_best_stream(u->fmt, AVMEDIA_TYPE_AUDIO, -1, -1, NULL, 0);
  if (u->si < 0) goto fail;
  u->st = u->fmt->streams[u->si];
  const AVCodec *c = avcodec_find_decoder(u->st->codecpar->codec_id);
  if (!c) goto fail;
  u->dec = avcodec_alloc_context3(c);
  avcodec_parameters_to_context(u->dec, u->st->codecpar);
  u->dec->pkt_timebase = u->st->time_base;
  if (avcodec_open2(u->dec, c, NULL) < 0) goto fail;
  u->pkt = av_packet_alloc(); u->frm = av_frame_alloc(); u->epkt = av_packet_alloc();
  u->in_rate = u->dec->sample_rate;
  u->dsd = c->id == AV_CODEC_ID_DSD_LSBF || c->id == AV_CODEC_ID_DSD_MSBF || c->id == AV_CODEC_ID_DSD_LSBF_PLANAR || c->id == AV_CODEC_ID_DSD_MSBF_PLANAR;

  /* 정보 */
  const AVCodecDescriptor *d = avcodec_descriptor_get(c->id);
  int bits = u->st->codecpar->bits_per_raw_sample;
  if (!bits) bits = u->dec->bits_per_raw_sample;
  if (!bits && d && (d->props & AV_CODEC_PROP_LOSSLESS)) bits = u->st->codecpar->bits_per_coded_sample;
  if (u->dsd) bits = 1;
  double dur = 0;
  if (u->st->duration != AV_NOPTS_VALUE && u->st->duration > 0) dur = u->st->duration * av_q2d(u->st->time_base);
  else if (u->fmt->duration > 0) dur = u->fmt->duration / (double)AV_TIME_BASE;
  int len = 0;
  char head[512];
  snprintf(head, sizeof head, "{\"codec\":\"%s\",\"rate\":%d,\"bits\":%d,\"ch\":%d,\"dur\":%.6f,\"lossless\":%d,\"dsd\":%d,\"kbps\":%d",
           c->name, u->dsd ? u->in_rate * 8 : u->in_rate, bits, u->dec->ch_layout.nb_channels, dur,
           (d && (d->props & AV_CODEC_PROP_LOSSLESS)) || u->dsd ? 1 : 0, u->dsd,
           (int)((u->st->codecpar->bit_rate ? u->st->codecpar->bit_rate : u->fmt->bit_rate) / 1000));
  jput(u, &len, head);
  jstr(u, &len, "name", d ? d->long_name : c->name);
  jstr(u, &len, "format", u->fmt->iformat->name);
  jstr(u, &len, "title", meta(u, "title"));
  jstr(u, &len, "artist", meta(u, "artist"));
  jstr(u, &len, "album", meta(u, "album"));
  jstr(u, &len, "albumArtist", meta(u, "album_artist"));
  jstr(u, &len, "genre", meta(u, "genre"));
  jstr(u, &len, "track", meta(u, "track"));
  jstr(u, &len, "lyrics", meta(u, "lyrics"));
  jput(u, &len, "}");
  return u;
fail:
  if (u->dec) avcodec_free_context(&u->dec);
  if (u->fmt) avformat_close_input(&u->fmt);
  if (u->avio) { av_freep(&u->avio->buffer); avio_context_free(&u->avio); }
  free(u);
  return 0;
}
EXPORT(ul_info) const char *ul_info(UL *u) { return u->info; }

/** 앨범아트 (없으면 길이 0) */
EXPORT(ul_pic_len) int ul_pic_len(UL *u) {
  for (unsigned i = 0; i < u->fmt->nb_streams; i++) {
    AVStream *s = u->fmt->streams[i];
    if ((s->disposition & AV_DISPOSITION_ATTACHED_PIC) && s->attached_pic.size > 0) return s->attached_pic.size;
  }
  return 0;
}
EXPORT(ul_pic_ptr) const uint8_t *ul_pic_ptr(UL *u) {
  for (unsigned i = 0; i < u->fmt->nb_streams; i++) {
    AVStream *s = u->fmt->streams[i];
    if ((s->disposition & AV_DISPOSITION_ATTACHED_PIC) && s->attached_pic.size > 0) return s->attached_pic.data;
  }
  return 0;
}
EXPORT(ul_pic_mime) int ul_pic_mime(UL *u) {   /* 0 jpeg · 1 png */
  for (unsigned i = 0; i < u->fmt->nb_streams; i++) {
    AVStream *s = u->fmt->streams[i];
    if ((s->disposition & AV_DISPOSITION_ATTACHED_PIC) && s->attached_pic.size > 0) return s->codecpar->codec_id == AV_CODEC_ID_PNG ? 1 : 0;
  }
  return 0;
}

/* ---------- 출력 준비: 리샘플러 · FLAC 인코더 ---------- */
static int enc_open(UL *u) {
  if (u->enc) avcodec_free_context(&u->enc);
  const AVCodec *fc = avcodec_find_encoder(AV_CODEC_ID_FLAC);
  if (!fc) return -1;
  u->enc = avcodec_alloc_context3(fc);
  u->enc->sample_rate = u->out_rate;
  av_channel_layout_default(&u->enc->ch_layout, u->out_ch);
  u->enc->sample_fmt = u->out_bits == 16 ? AV_SAMPLE_FMT_S16 : AV_SAMPLE_FMT_S32;
  u->enc->bits_per_raw_sample = u->out_bits;
  u->enc->time_base = (AVRational){ 1, u->out_rate };
  u->enc->frame_size = FRAME;
  u->enc->compression_level = 1;
  if (avcodec_open2(u->enc, fc, NULL) < 0) return -1;
  if (u->enc->extradata_size >= 34) memcpy(u->si_box, u->enc->extradata, 34);
  if (!u->ef) {
    u->ef = av_frame_alloc();
    u->ef->format = u->enc->sample_fmt;
    av_channel_layout_copy(&u->ef->ch_layout, &u->enc->ch_layout);
    u->ef->sample_rate = u->out_rate;
    u->ef->nb_samples = FRAME;
    if (av_frame_get_buffer(u->ef, 0) < 0) return -1;
  }
  u->ef_fill = 0;
  return 0;
}
static int swr_open(UL *u) {
  if (u->swr) swr_free(&u->swr);
  AVChannelLayout out; av_channel_layout_default(&out, u->out_ch);
  if (swr_alloc_set_opts2(&u->swr, &out, u->out_bits == 16 ? AV_SAMPLE_FMT_S16 : AV_SAMPLE_FMT_S32, u->out_rate,
                          &u->dec->ch_layout, u->dec->sample_fmt, u->in_rate, 0, NULL) < 0) return -1;
  if (u->out_rate != u->in_rate) {
    av_opt_set_int(u->swr, "filter_size", 64, 0);
    av_opt_set_int(u->swr, "phase_shift", 12, 0);
    av_opt_set_double(u->swr, "cutoff", 0.95, 0);
  }
  if (u->dec->ch_layout.nb_channels > 2) av_opt_set_double(u->swr, "rematrix_maxval", 1.0, 0);   /* 5.1 → 2: 넘치지 않게 */
  return swr_init(u->swr);
}

/** 출력 설정. max_rate: 이보다 높은 원본은 내려 받음(0 = 제한 없음, DSD 에만 씀). 성공 0 */
EXPORT(ul_start) int ul_start(UL *u, int max_rate) {
  u->out_ch = u->dec->ch_layout.nb_channels >= 2 ? 2 : 1;
  enum AVSampleFormat f = u->dec->sample_fmt;
  int raw = u->dec->bits_per_raw_sample;
  int is16 = (f == AV_SAMPLE_FMT_S16 || f == AV_SAMPLE_FMT_S16P || f == AV_SAMPLE_FMT_U8 || f == AV_SAMPLE_FMT_U8P) && (!raw || raw <= 16);
  u->out_bits = is16 && u->dec->ch_layout.nb_channels <= 2 ? 16 : 24;
  u->out_rate = u->in_rate;
  if (u->dsd) {                                   /* DSD64 → 88.2k, DSD128 이상 → 176.4k */
    u->out_rate = u->in_rate / 4;
    while (u->out_rate > 176400) u->out_rate /= 2;
    if (max_rate > 0) while (u->out_rate > max_rate && u->out_rate > 44100) u->out_rate /= 2;
  }
  while (u->out_rate > 384000) u->out_rate /= 2;
  u->bps = u->out_ch * (u->out_bits == 16 ? 2 : 4);
  if (swr_open(u) < 0 || enc_open(u) < 0) return -1;
  u->out_pts = 0;
  return 0;
}
EXPORT(ul_out_rate) int ul_out_rate(UL *u) { return u->out_rate; }
EXPORT(ul_out_ch) int ul_out_ch(UL *u) { return u->out_ch; }
EXPORT(ul_out_bits) int ul_out_bits(UL *u) { return u->out_bits; }
EXPORT(ul_streaminfo) const uint8_t *ul_streaminfo(UL *u) { return u->si_box; }

/* ---------- 출력 묶음 ---------- */
static int out_push(UL *u, AVPacket *p) {
  if (u->ob_len + p->size > u->ob_cap) {
    int cap = u->ob_cap ? u->ob_cap : 1 << 20;
    while (cap < u->ob_len + p->size) cap *= 2;
    uint8_t *nb = realloc(u->ob, cap); if (!nb) return -1; u->ob = nb; u->ob_cap = cap;
  }
  if (u->n >= u->ncap) {
    int cap = u->ncap ? u->ncap * 2 : 1024;
    int32_t *a = realloc(u->sz, cap * 4), *b = realloc(u->du, cap * 4);
    if (!a || !b) return -1;
    u->sz = a; u->du = b; u->ncap = cap;
  }
  if (u->n == 0) u->first_pts = (double)p->pts;
  memcpy(u->ob + u->ob_len, p->data, p->size);
  u->ob_len += p->size;
  u->sz[u->n] = p->size;
  u->du[u->n] = (int32_t)p->duration;
  u->n++;
  return 0;
}
static int enc_send(UL *u, AVFrame *f) {
  int r = avcodec_send_frame(u->enc, f);
  if (r < 0 && r != AVERROR_EOF) return r;
  while ((r = avcodec_receive_packet(u->enc, u->epkt)) == 0) {
    if (u->epkt->size > 0) {   /* 끝에 오는 빈 패킷(STREAMINFO 갱신용)은 버림 */
      if (!u->epkt->duration) u->epkt->duration = f ? f->nb_samples : FRAME;
      if (out_push(u, u->epkt) < 0) { av_packet_unref(u->epkt); return -1; }
    }
    av_packet_unref(u->epkt);
  }
  return 0;
}
/* 변환된 샘플을 FLAC 프레임(4096)씩 채워 인코더에 넣음 */
static int feed(UL *u, const uint8_t *src, int ns) {
  while (ns > 0) {
    if (av_frame_make_writable(u->ef) < 0) return -1;
    int take = FRAME - u->ef_fill; if (take > ns) take = ns;
    memcpy(u->ef->data[0] + u->ef_fill * u->bps, src, take * u->bps);
    u->ef_fill += take; src += take * u->bps; ns -= take;
    if (u->ef_fill == FRAME) {
      u->ef->nb_samples = FRAME; u->ef->pts = u->out_pts; u->out_pts += FRAME;
      if (enc_send(u, u->ef) < 0) return -1;
      u->ef_fill = 0;
    }
  }
  return 0;
}
static int convert(UL *u, AVFrame *f, int skip) {
  int in_n = f ? f->nb_samples - skip : 0;
  int max = swr_get_out_samples(u->swr, in_n > 0 ? in_n : 0) + 64;
  if (max * u->bps > u->tmp_cap) { u->tmp_cap = max * u->bps * 2; free(u->tmp); u->tmp = malloc(u->tmp_cap); if (!u->tmp) return -1; }
  uint8_t *out[1] = { u->tmp };
  int got;
  if (f) {
    const uint8_t *in[AV_NUM_DATA_POINTERS];
    int planar = av_sample_fmt_is_planar((enum AVSampleFormat)f->format), bs = av_get_bytes_per_sample((enum AVSampleFormat)f->format);
    int nch = f->ch_layout.nb_channels;
    for (int c = 0; c < (planar ? nch : 1) && c < AV_NUM_DATA_POINTERS; c++) in[c] = f->extended_data[c] + (size_t)skip * bs * (planar ? 1 : nch);
    got = swr_convert(u->swr, out, max, in, in_n);
  } else got = swr_convert(u->swr, out, max, NULL, 0);
  if (got < 0) return -1;
  return feed(u, u->tmp, got);
}

/** 적어도 secs 초 만큼(또는 끝까지) 풀어 FLAC 프레임으로 묶음. 반환: 프레임 수(0 = 끝), 음수 = 오류 */
EXPORT(ul_produce) int ul_produce(UL *u, double secs) {
  u->n = 0; u->ob_len = 0;
  if (u->done) return 0;
  int64_t want = (int64_t)(secs * u->out_rate);
  int64_t start = u->out_pts;
  while (u->out_pts - start < want) {
    int r = avcodec_receive_frame(u->dec, u->frm);
    if (r == AVERROR(EAGAIN)) {
      if (u->eof_in) break;
      r = av_read_frame(u->fmt, u->pkt);
      if (r < 0) { u->eof_in = 1; avcodec_send_packet(u->dec, NULL); continue; }
      if (u->pkt->stream_index == u->si) avcodec_send_packet(u->dec, u->pkt);   /* 깨진 패킷은 건너뜀 */
      av_packet_unref(u->pkt);
      continue;
    }
    if (r == AVERROR_EOF) {
      /* 끝: 리샘플러 · 인코더를 비움 */
      if (convert(u, NULL, 0) < 0) return -1;
      if (u->ef_fill > 0) {
        u->ef->nb_samples = u->ef_fill; u->ef->pts = u->out_pts; u->out_pts += u->ef_fill;
        if (enc_send(u, u->ef) < 0) return -1;
        u->ef_fill = 0;
      }
      enc_send(u, NULL);
      u->done = 1;
      break;
    }
    if (r < 0) return -1;
    int skip = 0;
    if (u->seek_to >= 0) {
      int64_t ts = u->frm->best_effort_timestamp;
      if (ts != AV_NOPTS_VALUE) {
        if (u->st->start_time != AV_NOPTS_VALUE) ts -= u->st->start_time;
        double t = ts * av_q2d(u->st->time_base);
        double tend = t + (double)u->frm->nb_samples / u->in_rate;
        if (tend <= u->seek_to) { av_frame_unref(u->frm); continue; }          /* 목표 앞 프레임은 버림 */
        if (t < u->seek_to) { skip = (int)llround((u->seek_to - t) * u->in_rate); if (skip >= u->frm->nb_samples) skip = u->frm->nb_samples - 1; t = u->seek_to; }
        u->out_pts = llround(t * u->out_rate);
      } else u->out_pts = llround(u->seek_to * u->out_rate);
      u->seek_to = -1;
    }
    r = convert(u, u->frm, skip);
    av_frame_unref(u->frm);
    if (r < 0) return -1;
  }
  return u->n;
}
EXPORT(ul_out_ptr) const uint8_t *ul_out_ptr(UL *u) { return u->ob; }
EXPORT(ul_out_len) int ul_out_len(UL *u) { return u->ob_len; }
EXPORT(ul_sizes) const int32_t *ul_sizes(UL *u) { return u->sz; }
EXPORT(ul_durs) const int32_t *ul_durs(UL *u) { return u->du; }
EXPORT(ul_first_pts) double ul_first_pts(UL *u) { return u->first_pts; }
EXPORT(ul_done) int ul_done(UL *u) { return u->done; }

/** t 초로 이동. 다음 ul_produce 는 t 부터의 소리를 돌려준다 (첫 프레임 pts = t × 출력 샘플레이트) */
EXPORT(ul_seek) int ul_seek(UL *u, double t) {
  if (t < 0) t = 0;
  int64_t ts = (int64_t)(t * AV_TIME_BASE);
  int r = av_seek_frame(u->fmt, -1, ts, AVSEEK_FLAG_BACKWARD);
  if (r < 0) r = av_seek_frame(u->fmt, -1, ts, AVSEEK_FLAG_BACKWARD | AVSEEK_FLAG_ANY);
  if (r < 0) {   /* 시크를 못 하는 형식: 처음부터 풀며 버림 */
    avio_seek(u->fmt->pb, 0, SEEK_SET);
    r = avformat_seek_file(u->fmt, -1, INT64_MIN, 0, 0, 0);
  }
  avcodec_flush_buffers(u->dec);
  u->eof_in = 0; u->done = 0;
  u->seek_to = t;
  u->out_pts = llround(t * u->out_rate);
  if (swr_open(u) < 0 || enc_open(u) < 0) return -1;
  return r < 0 ? -1 : 0;
}

EXPORT(ul_close) void ul_close(UL *u) {
  if (!u) return;
  if (u->swr) swr_free(&u->swr);
  if (u->enc) avcodec_free_context(&u->enc);
  if (u->ef) av_frame_free(&u->ef);
  if (u->dec) avcodec_free_context(&u->dec);
  if (u->pkt) av_packet_free(&u->pkt);
  if (u->epkt) av_packet_free(&u->epkt);
  if (u->frm) av_frame_free(&u->frm);
  if (u->fmt) avformat_close_input(&u->fmt);
  if (u->avio) { av_freep(&u->avio->buffer); avio_context_free(&u->avio); }
  free(u->tmp); free(u->ob); free(u->sz); free(u->du);
  free(u);
}

/* JS 가 쓰는 메모리 */
EXPORT(ul_malloc) void *ul_malloc(int n) { return malloc(n); }
EXPORT(ul_free) void ul_free(void *p) { free(p); }
