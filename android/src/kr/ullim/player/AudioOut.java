package kr.ullim.player;

import android.content.Context;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.lang.reflect.Method;
import java.util.List;

/**
 * 고음질 출력 (DAC)
 *  - 지금 음악이 나가는 장치(내장 스피커 · 유선 · USB DAC · 블루투스)와 그 장치가 받는 형식을 화면에 알려 줌
 *  - USB DAC: 안드로이드 14(API 34)부터 앱이 USB 출력의 형식을 정할 수 있다(AudioMixerAttributes).
 *    '자동'이면 DAC 가 받는 가장 높은 비트(32 → 24 → 16)와, 앱 출력(보통 48kHz)의 정수배 중 가장 높은
 *    샘플레이트(최대 192kHz)로 연다 → 휴대폰이 16비트 · 48kHz 로 줄이지 않고 그대로 DAC 에 보냄.
 *    (비트 퍼펙트 모드는 앱 소리의 형식이 DAC 형식과 똑같아야 해서 쓰지 않음 — 다른 소리와 섞이지 않게 막히기도 함)
 *  - 권한이 필요 없다. API 34 메서드는 이 빌드의 android.jar(33)에 없어서 리플렉션으로 부른다.
 */
final class AudioOut {
    final MainActivity a;
    final AudioManager am;
    final AudioAttributes media;
    final SharedPreferences prefs;
    String mode;                    // "auto" · "off" · "<샘플레이트>/<인코딩>"
    Object applied;                 // 지금 USB 에 정한 AudioMixerAttributes
    AudioDeviceInfo appliedDev;
    AudioDeviceCallback cb;
    Method mSupported, mSetPref, mGetPref, mClearPref, mFormat, mBehavior;

    AudioOut(MainActivity act) {
        a = act;
        am = (AudioManager) a.getSystemService(Context.AUDIO_SERVICE);
        media = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build();
        prefs = a.getSharedPreferences("ullim", Context.MODE_PRIVATE);
        mode = prefs.getString("hires", "auto");
        if (Build.VERSION.SDK_INT >= 34) {
            try {
                Class<?> mix = Class.forName("android.media.AudioMixerAttributes");
                mSupported = AudioManager.class.getMethod("getSupportedMixerAttributes", AudioDeviceInfo.class);
                mSetPref = AudioManager.class.getMethod("setPreferredMixerAttributes", AudioAttributes.class, AudioDeviceInfo.class, mix);
                mGetPref = AudioManager.class.getMethod("getPreferredMixerAttributes", AudioAttributes.class, AudioDeviceInfo.class);
                mClearPref = AudioManager.class.getMethod("clearPreferredMixerAttributes", AudioAttributes.class, AudioDeviceInfo.class);
                mFormat = mix.getMethod("getFormat");
                mBehavior = mix.getMethod("getMixerBehavior");
            } catch (Exception e) { mSupported = null; }
        }
        cb = new DevCb(this);
        try { am.registerAudioDeviceCallback(cb, a.main); } catch (Exception e) { cb = null; }   // 등록하면 지금 장치로 한 번 불림
    }
    /** (빌드의 d8 이 오래돼 익명 클래스 대신 static 중첩 클래스) */
    static final class DevCb extends AudioDeviceCallback {
        final AudioOut o;
        DevCb(AudioOut o) { this.o = o; }
        @Override public void onAudioDevicesAdded(AudioDeviceInfo[] d) { o.refresh(); }
        @Override public void onAudioDevicesRemoved(AudioDeviceInfo[] d) { o.refresh(); }
    }

    boolean hiresCapable() { return mSupported != null; }

    void release() {
        if (cb != null) { try { am.unregisterAudioDeviceCallback(cb); } catch (Exception e) { /* noop */ } cb = null; }
        clear();
    }

    /** 장치가 바뀜 → USB 형식 다시 정하고 화면에 알림 */
    void refresh() {
        apply();
        a.js("window.__ullimAudioOut && window.__ullimAudioOut(" + JSONObject.quote(info()) + ")");
    }

    void setMode(String m) {
        mode = m == null || m.isEmpty() ? "auto" : m;
        prefs.edit().putString("hires", mode).apply();
        refresh();
    }

    static boolean isUsbOut(int t) { return t == AudioDeviceInfo.TYPE_USB_DEVICE || t == AudioDeviceInfo.TYPE_USB_HEADSET; }

    AudioDeviceInfo usb() {
        for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) if (isUsbOut(d.getType())) return d;
        return null;
    }

    /** 미디어 소리가 지금 나가는 장치 */
    AudioDeviceInfo current() {
        if (Build.VERSION.SDK_INT >= 33) {
            try { List<AudioDeviceInfo> l = am.getAudioDevicesForAttributes(media); if (l != null && !l.isEmpty()) return l.get(0); } catch (Exception e) { /* noop */ }
        }
        AudioDeviceInfo best = null; int br = -1;
        for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) { int r = rank(d.getType()); if (r > br) { br = r; best = d; } }
        return best;
    }
    static int rank(int t) {
        switch (t) {
            case AudioDeviceInfo.TYPE_USB_DEVICE: case AudioDeviceInfo.TYPE_USB_HEADSET: return 9;
            case AudioDeviceInfo.TYPE_USB_ACCESSORY: return 8;
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES: case AudioDeviceInfo.TYPE_WIRED_HEADSET: return 7;
            case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP: case 26: case 27: return 6;   // 26 · 27 = BLE 헤드셋 · 스피커 (LE Audio)
            case AudioDeviceInfo.TYPE_HDMI: return 5;
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER: return 1;
            default: return 0;
        }
    }
    static String kind(int t) {
        switch (t) {
            case AudioDeviceInfo.TYPE_USB_DEVICE: case AudioDeviceInfo.TYPE_USB_HEADSET: case AudioDeviceInfo.TYPE_USB_ACCESSORY: return "usb";
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES: case AudioDeviceInfo.TYPE_WIRED_HEADSET: case AudioDeviceInfo.TYPE_LINE_ANALOG: return "wired";
            case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP: case AudioDeviceInfo.TYPE_BLUETOOTH_SCO: return "bt";
            case 26: case 27: return "ble";
            case AudioDeviceInfo.TYPE_HDMI: case AudioDeviceInfo.TYPE_HDMI_ARC: return "hdmi";
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER: case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE: return "speaker";
            default: return "other";
        }
    }
    static int bitsOf(int enc) {
        switch (enc) {
            case AudioFormat.ENCODING_PCM_FLOAT: return 32;
            case 22: return 32;     // ENCODING_PCM_32BIT
            case 21: return 24;     // ENCODING_PCM_24BIT_PACKED
            case AudioFormat.ENCODING_PCM_16BIT: return 16;
            case AudioFormat.ENCODING_PCM_8BIT: return 8;
            default: return 0;
        }
    }
    /** 높은 품질 순서: 32비트 정수 > 실수 > 24비트 > 16비트 */
    static int encRank(int enc) {
        switch (enc) {
            case 22: return 5;
            case AudioFormat.ENCODING_PCM_FLOAT: return 4;
            case 21: return 3;
            case AudioFormat.ENCODING_PCM_16BIT: return 1;
            default: return 0;
        }
    }
    int nativeRate() {
        try { return Integer.parseInt(am.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE)); } catch (Exception e) { return 48000; }
    }

    /* ---------- USB DAC 형식 (API 34) ---------- */
    List<?> supported(AudioDeviceInfo d) {
        try { return (List<?>) mSupported.invoke(am, d); } catch (Exception e) { return null; }
    }
    AudioFormat fmtOf(Object mix) { try { return (AudioFormat) mFormat.invoke(mix); } catch (Exception e) { return null; } }
    int behaviorOf(Object mix) { try { return (Integer) mBehavior.invoke(mix); } catch (Exception e) { return -1; } }

    Object choose(List<?> list) {
        if (list == null) return null;
        Object best = null; long bestScore = -1;
        int nat = nativeRate();
        for (Object m : list) {
            AudioFormat f = fmtOf(m);
            if (f == null || behaviorOf(m) != 0) continue;                                  // 0 = 기본(섞기), 1 = 비트 퍼펙트
            if (f.getChannelMask() != AudioFormat.CHANNEL_OUT_STEREO) continue;
            int r = f.getSampleRate(), e = f.getEncoding();
            if (!"auto".equals(mode)) { if ((r + "/" + e).equals(mode)) return m; continue; }
            if (encRank(e) == 0 || r <= 0) continue;
            // 앱 출력(보통 48kHz)의 정수배 · 192kHz 이하를 먼저, 그다음 높은 샘플레이트
            int rateClass = (r % nat == 0 && r <= 192000) ? 2 : r <= 192000 ? 1 : 0;
            long score = (long) encRank(e) * 100000000L + rateClass * 10000000L + r;
            if (score > bestScore) { bestScore = score; best = m; }
        }
        return best;
    }

    void clear() {
        if (applied != null && appliedDev != null && mClearPref != null) {
            try { mClearPref.invoke(am, media, appliedDev); } catch (Exception e) { /* noop */ }
        }
        applied = null; appliedDev = null;
    }

    void apply() {
        if (!hiresCapable()) return;
        AudioDeviceInfo d = usb();
        if (d == null) { applied = null; appliedDev = null; return; }
        if ("off".equals(mode)) { appliedDev = d; applied = new Object(); clear(); return; }
        Object pick = choose(supported(d));
        if (pick == null) return;
        try {
            Object ok = mSetPref.invoke(am, media, d, pick);
            if (Boolean.TRUE.equals(ok)) { applied = pick; appliedDev = d; }
        } catch (Exception e) { /* 이 DAC · 기기는 지원하지 않음 */ }
    }

    static JSONObject fmtJson(AudioFormat f) throws Exception {
        JSONObject o = new JSONObject();
        o.put("rate", f.getSampleRate());
        o.put("enc", f.getEncoding());
        o.put("bits", bitsOf(f.getEncoding()));
        o.put("float", f.getEncoding() == AudioFormat.ENCODING_PCM_FLOAT);
        return o;
    }

    /** 화면에 보낼 정보 (JSON) */
    String info() {
        JSONObject o = new JSONObject();
        try {
            o.put("sdk", Build.VERSION.SDK_INT);
            o.put("hires", hiresCapable());
            o.put("mode", mode);
            o.put("native", nativeRate());
            AudioDeviceInfo d = current();
            if (d != null) {
                JSONObject out = new JSONObject();
                out.put("type", kind(d.getType()));
                CharSequence n = d.getProductName();
                out.put("name", n == null ? "" : n.toString());
                JSONArray rates = new JSONArray(); for (int r : d.getSampleRates()) rates.put(r); out.put("rates", rates);
                JSONArray encs = new JSONArray(); for (int e : d.getEncodings()) encs.put(bitsOf(e)); out.put("bits", encs);
                o.put("out", out);
            }
            AudioDeviceInfo u = usb();
            if (u != null && hiresCapable()) {
                JSONArray opts = new JSONArray();
                List<?> list = supported(u);
                if (list != null) for (Object m : list) {
                    AudioFormat f = fmtOf(m);
                    if (f == null || behaviorOf(m) != 0 || f.getChannelMask() != AudioFormat.CHANNEL_OUT_STEREO || encRank(f.getEncoding()) == 0) continue;
                    opts.put(fmtJson(f));
                }
                o.put("options", opts);
                Object pref = null;
                try { pref = mGetPref.invoke(am, media, u); } catch (Exception e) { /* noop */ }
                if (pref != null && fmtOf(pref) != null) o.put("mixer", fmtJson(fmtOf(pref)));
            }
        } catch (Exception e) { /* 일부만 */ }
        return o.toString();
    }
}
