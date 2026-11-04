package kr.ullim.player;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.view.View;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** 울림 — 안드로이드 화면(WebView)과 기기 기능 연결 */
public class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net";
    static final String ORIGIN = "https://" + HOST;
    static final int REQ_FILES = 11, REQ_TREE = 12, REQ_PERM_AUDIO = 21;
    static final String[] AUDIO_EXT = {"mp3", "m4a", "m4b", "mp4", "aac", "flac", "ogg", "oga", "opus", "wav", "wave", "webm", "weba", "mka",
        "ape", "wv", "tta", "dsf", "dff", "wma", "aif", "aiff", "aifc", "ac3", "eac3", "dts", "mp2", "mpc", "tak", "shn", "caf", "w64"};   // 뒤쪽은 코덱 엔진(FFmpeg wasm)으로

    static MainActivity instance;
    final Handler main = new Handler(Looper.getMainLooper());
    String appVersion = "1";
    WebView web;
    String reqFiles, reqTree, reqScan, pendingOpen;
    boolean pageReady;
    AudioOut audioOut;              // 고음질 출력 (DAC)

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        try { appVersion = getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { /* noop */ }
        instance = this;
        Window w = getWindow();
        w.setStatusBarColor(0xFF171A1F);
        w.setNavigationBarColor(0xFF171A1F);

        web = new WebView(this);
        web.setBackgroundColor(0xFF0F1114);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        if (Build.VERSION.SDK_INT >= 26) web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        web.setWebViewClient(new Client(this));
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bridge(this), "UllimAndroid");
        setContentView(web);
        web.loadUrl(ORIGIN + "/index.html");
        watchNetwork();
        try { audioOut = new AudioOut(this); } catch (Exception e) { audioOut = null; }
        if (state == null) {
            handleIntent(getIntent());
            new Thread(this::removeOldUpdateFiles).start();
        }
    }

    /** 1.1.0 이 받아 두었을 수 있는 업데이트 파일 정리 (1.1.1 부터 앱이 직접 설치하지 않음) */
    void removeOldUpdateFiles() {
        java.io.File d = new java.io.File(getCacheDir(), "update");
        java.io.File[] fs = d.listFiles();
        if (fs != null) for (java.io.File f : fs) f.delete();
        d.delete();
        new java.io.File(getFilesDir(), "update-committed").delete();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.__ullimBack ? window.__ullimBack() : false", v -> {
            if (!"true".equals(v)) moveTaskToBack(true);
        });
    }

    @Override
    protected void onDestroy() {
        if (netCb != null) { try { getSystemService(ConnectivityManager.class).unregisterNetworkCallback(netCb); } catch (Exception e) { /* noop */ } netCb = null; }
        if (audioOut != null) { audioOut.release(); audioOut = null; }   // USB DAC 형식을 안드로이드 기본으로 되돌림
        if (isFinishing()) PlaybackService.stop(this);
        if (instance == this) instance = null;
        if (web != null) { web.destroy(); web = null; }
        super.onDestroy();
    }

    /* ---------------- 연결 종류 (와이파이 · 모바일 데이터) ---------------- */
    NetCb netCb;
    String lastNet = "";
    /** "wifi"(이더넷 포함) · "cellular" · "other" · "none" · "unknown" */
    String netType() {
        try {
            ConnectivityManager cm = getSystemService(ConnectivityManager.class);
            Network n = cm.getActiveNetwork();
            if (n == null) return "none";
            NetworkCapabilities c = cm.getNetworkCapabilities(n);
            if (c == null) return "none";
            if (c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || c.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) return "wifi";
            if (c.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) return "cellular";
            return "other";
        } catch (Exception e) { return "unknown"; }
    }
    void watchNetwork() {
        try {
            netCb = new NetCb(this);
            getSystemService(ConnectivityManager.class).registerDefaultNetworkCallback(netCb);
        } catch (Exception e) { netCb = null; }
    }
    void notifyNet() {
        final String t = netType();
        if (t.equals(lastNet)) return;
        lastNet = t;
        js("window.__ullimNet && window.__ullimNet(" + JSONObject.quote(t) + ")");
    }
    static class NetCb extends ConnectivityManager.NetworkCallback {
        final MainActivity a;
        NetCb(MainActivity a) { this.a = a; }
        @Override public void onCapabilitiesChanged(Network n, NetworkCapabilities c) { a.notifyNet(); }
        @Override public void onLost(Network n) { a.notifyNet(); }
        @Override public void onAvailable(Network n) { a.notifyNet(); }
    }

    /* ---------------- JS 호출 ---------------- */
    void js(String code) {
        main.post(() -> { if (web != null) web.evaluateJavascript(code, null); });
    }
    void resolve(String id, String json) {
        js("window.__ullimResolve && window.__ullimResolve(" + JSONObject.quote(id) + "," + JSONObject.quote(json) + ",null)");
    }
    void reject(String id, String msg) {
        js("window.__ullimResolve && window.__ullimResolve(" + JSONObject.quote(id) + ",null," + JSONObject.quote(msg) + ")");
    }
    static void command(String cmd, String arg) {
        MainActivity a = instance;
        if (a == null) return;
        a.js("window.__ullimCommand && window.__ullimCommand(" + JSONObject.quote(cmd) + "," + (arg == null ? "null" : JSONObject.quote(arg)) + ")");
    }

    static class Bridge {
        final MainActivity a;
        Bridge(MainActivity activity) { a = activity; }
        @JavascriptInterface
        public void call(final String method, final String args, final String id) {
            a.main.post(() -> a.dispatch(method, args, id));
        }
        @JavascriptInterface
        public void nowPlaying(final String json) {
            a.main.post(() -> PlaybackService.update(a, json));
        }
        @JavascriptInterface
        public void setSystemBars(final String color, final boolean light) {
            a.main.post(() -> a.applyBars(color, light));
        }
        @JavascriptInterface
        public void ready() {
            a.main.post(a::onPageReady);
        }
        @JavascriptInterface
        public void release(final String keysJson) {
            new Thread(() -> a.releaseGrants(keysJson)).start();
        }
        /** 가사 제보 등: GitHub · LRCLIB 페이지만 브라우저로 연다 */
        @JavascriptInterface
        public void openUrl(final String url) {
            if (url == null || !(url.startsWith("https://github.com/") || url.startsWith("https://lrclib.net/"))) return;
            a.main.post(() -> {
                try { a.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)); } catch (Exception e) { /* 브라우저 없음 */ }
            });
        }
        /** 업데이트 확인: 설치된 버전 번호 (update/latest.json 의 versionCode 와 비교) */
        @JavascriptInterface
        public int versionCode() {
            try {
                android.content.pm.PackageInfo p = a.getPackageManager().getPackageInfo(a.getPackageName(), 0);
                return (int) (Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode);
            } catch (Exception e) { return 0; }
        }
        /** 지금 연결: "wifi" · "cellular" · "other" · "none" (모바일 데이터면 가사를 자동으로 찾지 않기) */
        @JavascriptInterface
        public String net() { return a.netType(); }
        /** 배터리 절약 모드면 유리 효과(흐림 · 굴절)를 끈다 — 권한 필요 없음 */
        @JavascriptInterface
        public boolean powerSave() {
            try {
                android.os.PowerManager pm = (android.os.PowerManager) a.getSystemService(android.content.Context.POWER_SERVICE);
                return pm != null && pm.isPowerSaveMode();
            } catch (Exception e) { return false; }
        }
        /** 고음질 출력 (DAC): 지금 출력 장치 · USB DAC 형식 (JSON) */
        @JavascriptInterface
        public String audioOut() { AudioOut o = a.audioOut; return o != null ? o.info() : "{}"; }
        /** USB DAC 형식: "auto"(최고 품질) · "off"(안드로이드 기본) · "<샘플레이트>/<인코딩>" */
        @JavascriptInterface
        public void setHiRes(final String mode) { a.main.post(() -> { if (a.audioOut != null) a.audioOut.setMode(mode); }); }
        @JavascriptInterface
        public void exitApp() {
            a.main.post(() -> { PlaybackService.stop(a); a.finishAndRemoveTask(); });
        }
    }

    void dispatch(String method, String args, String id) {
        if ("httpGet".equals(method)) { String url = null; try { url = new JSONArray(args).optString(0, null); } catch (Exception e) { /* noop */ } httpGet(id, url); }
        else if ("httpPost".equals(method)) {
            String url = null, body = null;
            try { JSONArray a = new JSONArray(args); url = a.optString(0, null); body = a.optString(1, null); } catch (Exception e) { /* noop */ }
            httpPost(id, url, body);
        }
        else if ("pickFiles".equals(method)) pickFiles(id);
        else if ("pickFolder".equals(method)) pickFolder(id);
        else if ("scanLibrary".equals(method)) scanLibrary(id);
        else reject(id, "unknown method");
    }

    void onPageReady() {
        pageReady = true;
        if (pendingOpen != null) { js("window.__ullimOpen && window.__ullimOpen(" + JSONObject.quote(pendingOpen) + ")"); pendingOpen = null; }
    }

    /** 가사 · 업데이트 확인용: LRCLIB, 커뮤니티 가사 목록 · 업데이트 정보(GitHub) 주소만 허용 */
    void httpGet(final String id, final String url) {
        if (url == null || !(url.startsWith("https://lrclib.net/api/") || url.startsWith("https://raw.githubusercontent.com/omokdie/ullim/main/lyrics/")
                || url.startsWith("https://raw.githubusercontent.com/omokdie/ullim/main/update/"))) { reject(id, "bad url"); return; }
        new Thread(() -> {
            java.net.HttpURLConnection c = null;
            JSONObject o = new JSONObject();
            try {
                c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                c.setConnectTimeout(10000);
                c.setReadTimeout(15000);
                // LRCLIB 요청 규칙: 앱 이름 · 버전 · 프로젝트 주소
                c.setRequestProperty("User-Agent", "Ullim v" + appVersion + " (https://github.com/omokdie/ullim)");
                c.setRequestProperty("Accept", "application/json");
                int code = c.getResponseCode();
                String ra = c.getHeaderField("Retry-After");
                if (ra != null) o.put("retryAfter", ra);
                InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
                java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                if (in != null) {
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = in.read(buf)) > 0 && bos.size() < (4 << 20)) bos.write(buf, 0, n);
                    in.close();
                }
                o.put("status", code);
                o.put("body", new String(bos.toByteArray(), java.nio.charset.StandardCharsets.UTF_8));
            } catch (Exception e) {
                // 시간 초과(서버가 느림)와 연결 안 됨(인터넷 끊김)을 구분해 알려 준다
                String kind = e instanceof java.net.SocketTimeoutException ? "timeout"
                    : (e instanceof java.net.UnknownHostException || e instanceof java.net.NoRouteToHostException) ? "offline" : "network";
                try { o.put("status", 0); o.put("body", ""); o.put("error", kind); } catch (Exception ignored) { /* noop */ }
            } finally {
                if (c != null) c.disconnect();
            }
            resolve(id, o.toString());
        }).start();
    }

    /** 고른 가사 알리기: 이 메시지함 주소에만, 작은 글만 보낸다 (web/js/lyrics.js 의 FEEDBACK_URL) */
    static final String FEEDBACK_URL = "https://ntfy.sh/ullim-lyrics-259gyx3gfnw7";
    void httpPost(final String id, final String url, final String body) {
        if (!FEEDBACK_URL.equals(url) || body == null) { reject(id, "bad url"); return; }
        final byte[] data = body.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        if (data.length > 4000) { reject(id, "too big"); return; }
        new Thread(() -> {
            java.net.HttpURLConnection c = null;
            int code = 0;
            try {
                c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                c.setConnectTimeout(10000);
                c.setReadTimeout(15000);
                c.setDoOutput(true);
                c.setRequestMethod("POST");
                c.setFixedLengthStreamingMode(data.length);
                c.setRequestProperty("User-Agent", "Ullim/" + appVersion + " (Android music player)");
                c.setRequestProperty("Content-Type", "text/plain; charset=utf-8");
                java.io.OutputStream os = c.getOutputStream();
                os.write(data);
                os.close();
                code = c.getResponseCode();
                InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
                if (in != null) { byte[] buf = new byte[4096]; while (in.read(buf) > 0) { /* 버림 */ } in.close(); }
            } catch (Exception e) {
                code = 0;
            } finally {
                if (c != null) c.disconnect();
            }
            JSONObject o = new JSONObject();
            try { o.put("status", code); } catch (Exception ignored) { /* noop */ }
            resolve(id, o.toString());
        }).start();
    }

    void applyBars(String hex, boolean light) {
        int c;
        try { c = Color.parseColor(hex.trim()); } catch (Exception e) { return; }
        Window w = getWindow();
        w.setStatusBarColor(c);
        w.setNavigationBarColor(c);
        View d = w.getDecorView();
        int f = d.getSystemUiVisibility();
        if (light) f |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR; else f &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (Build.VERSION.SDK_INT >= 26) {
            if (light) f |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR; else f &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        d.setSystemUiVisibility(f);
    }

    /* ---------------- 파일 · 폴더 · 기기 음악 ---------------- */
    void pickFiles(String id) {
        if (reqFiles != null) resolve(reqFiles, "[]");
        reqFiles = id;
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"audio/*", "application/ogg", "application/x-ogg", "application/flac", "application/x-flac"});
        i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        try { startActivityForResult(i, REQ_FILES); }
        catch (Exception e) { reqFiles = null; reject(id, "파일 선택 화면을 열 수 없어요"); }
    }

    void pickFolder(String id) {
        if (reqTree != null) resolve(reqTree, "[]");
        reqTree = id;
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        try { startActivityForResult(i, REQ_TREE); }
        catch (Exception e) { reqTree = null; reject(id, "폴더 선택 화면을 열 수 없어요"); }
    }

    void scanLibrary(String id) {
        String perm = Build.VERSION.SDK_INT >= 33 ? "android.permission.READ_MEDIA_AUDIO" : "android.permission.READ_EXTERNAL_STORAGE";
        if (checkSelfPermission(perm) != PackageManager.PERMISSION_GRANTED) {
            reqScan = id;
            requestPermissions(new String[]{perm}, REQ_PERM_AUDIO);
            return;
        }
        new Thread(() -> doScan(id)).start();
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] results) {
        super.onRequestPermissionsResult(req, perms, results);
        if (req != REQ_PERM_AUDIO || reqScan == null) return;
        final String id = reqScan;
        reqScan = null;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) new Thread(() -> doScan(id)).start();
        else reject(id, "기기 음악을 불러오려면 '음악 및 오디오' 권한을 허용해 주세요");
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_FILES) {
            final String id = reqFiles;
            reqFiles = null;
            if (id == null) return;
            if (res != RESULT_OK || data == null) { resolve(id, "[]"); return; }
            final List<Uri> uris = new ArrayList<>();
            ClipData clip = data.getClipData();
            if (clip != null) { for (int k = 0; k < clip.getItemCount(); k++) uris.add(clip.getItemAt(k).getUri()); }
            else if (data.getData() != null) uris.add(data.getData());
            new Thread(() -> {
                JSONArray arr = new JSONArray();
                for (Uri u : uris) { persist(u); arr.put(item(u, displayName(u))); }
                warnIfManyGrants();
                resolve(id, arr.toString());
            }).start();
        } else if (req == REQ_TREE) {
            final String id = reqTree;
            reqTree = null;
            if (id == null) return;
            if (res != RESULT_OK || data == null || data.getData() == null) { resolve(id, "[]"); return; }
            final Uri tree = data.getData();
            persist(tree);
            new Thread(() -> {
                JSONArray arr = new JSONArray();
                try { walkTree(tree, DocumentsContract.getTreeDocumentId(tree), arr, 0); }
                catch (Exception e) { /* partial result */ }
                resolve(id, arr.toString());
            }).start();
        }
    }

    void releaseGrants(String keysJson) {
        try {
            JSONArray arr = new JSONArray(keysJson);
            java.util.HashSet<String> held = new java.util.HashSet<>();
            for (android.content.UriPermission p : getContentResolver().getPersistedUriPermissions()) held.add(p.getUri().toString());
            for (int k = 0; k < arr.length(); k++) {
                String key = arr.optString(k);
                if (!held.contains(key)) continue;
                try { getContentResolver().releasePersistableUriPermission(Uri.parse(key), Intent.FLAG_GRANT_READ_URI_PERMISSION); }
                catch (Exception e) { /* noop */ }
            }
        } catch (Exception e) { /* noop */ }
    }

    void warnIfManyGrants() {
        int n = getContentResolver().getPersistedUriPermissions().size();
        int limit = Build.VERSION.SDK_INT >= 30 ? 512 : 128;
        if (n >= limit - 16) main.post(() -> android.widget.Toast.makeText(this,
                "파일을 하나씩 너무 많이 추가했어요. 많은 곡은 '폴더 추가'나 '기기 음악 불러오기'를 써 주세요.", android.widget.Toast.LENGTH_LONG).show());
    }

    void persist(Uri u) {
        try { getContentResolver().takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION); }
        catch (Exception e) { /* temporary permission only */ }
    }

    String displayName(Uri u) {
        String name = null;
        try (Cursor c = getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) name = c.getString(0);
        } catch (Exception e) { /* noop */ }
        if (name == null) { name = u.getLastPathSegment(); if (name == null) name = "audio"; int s = name.lastIndexOf('/'); if (s >= 0) name = name.substring(s + 1); }
        return name;
    }

    static JSONObject item(Uri u, String name) {
        JSONObject o = new JSONObject();
        try { o.put("key", u.toString()); o.put("name", name); } catch (Exception e) { /* noop */ }
        return o;
    }

    static boolean isAudio(String name, String mime) {
        if (mime != null && (mime.startsWith("audio/") || mime.equals("application/ogg") || mime.contains("flac"))) return true;
        int d = name.lastIndexOf('.');
        if (d < 0) return false;
        String ext = name.substring(d + 1).toLowerCase(Locale.ROOT);
        for (String e : AUDIO_EXT) if (e.equals(ext)) return true;
        return false;
    }

    static int natCmp(String a, String b) {
        int i = 0, j = 0, na = a.length(), nb = b.length();
        while (i < na && j < nb) {
            char ca = a.charAt(i), cb = b.charAt(j);
            if (Character.isDigit(ca) && Character.isDigit(cb)) {
                int si = i, sj = j;
                while (i < na && Character.isDigit(a.charAt(i))) i++;
                while (j < nb && Character.isDigit(b.charAt(j))) j++;
                String da = a.substring(si, i).replaceFirst("^0+(?!$)", ""), db = b.substring(sj, j).replaceFirst("^0+(?!$)", "");
                if (da.length() != db.length()) return da.length() - db.length();
                int c = da.compareTo(db);
                if (c != 0) return c;
            } else {
                int c = Character.toLowerCase(ca) - Character.toLowerCase(cb);
                if (c != 0) return c;
                i++; j++;
            }
        }
        return (na - i) - (nb - j);
    }

    void walkTree(Uri tree, String docId, JSONArray out, int depth) {
        if (depth > 14 || out.length() >= 30000) return;
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId);
        List<String[]> dirs = new ArrayList<>(), files = new ArrayList<>();
        String[] proj = {DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE};
        try (Cursor c = getContentResolver().query(children, proj, null, null, null)) {
            if (c == null) return;
            while (c.moveToNext()) {
                String id = c.getString(0), name = c.getString(1), mime = c.getString(2);
                if (name == null || name.startsWith(".")) continue;
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) dirs.add(new String[]{id, name});
                else if (isAudio(name, mime)) files.add(new String[]{id, name});
            }
        } catch (Exception e) { return; }
        files.sort((x, y) -> natCmp(x[1], y[1]));
        dirs.sort((x, y) -> natCmp(x[1], y[1]));
        for (String[] f : files) out.put(item(DocumentsContract.buildDocumentUriUsingTree(tree, f[0]), f[1]));
        for (String[] d : dirs) walkTree(tree, d[0], out, depth + 1);
    }

    void doScan(String id) {
        JSONArray arr = new JSONArray();
        Uri base = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
        String[] proj = {MediaStore.Audio.Media._ID, MediaStore.Audio.Media.TITLE, MediaStore.Audio.Media.ARTIST,
                MediaStore.Audio.Media.ALBUM, MediaStore.Audio.Media.DURATION, MediaStore.Audio.Media.DISPLAY_NAME};
        List<JSONObject> rows = new ArrayList<>();
        try (Cursor c = getContentResolver().query(base, proj, MediaStore.Audio.Media.IS_MUSIC + " != 0", null, null)) {
            if (c != null) {
                while (c.moveToNext()) {
                    JSONObject o = new JSONObject();
                    String artist = c.getString(2), album = c.getString(3), name = c.getString(5);
                    if (artist == null || "<unknown>".equals(artist)) artist = "";
                    if (album == null || "<unknown>".equals(album)) album = "";
                    o.put("key", ContentUris.withAppendedId(base, c.getLong(0)).toString());
                    o.put("name", name != null ? name : "audio");
                    o.put("title", c.getString(1) != null ? c.getString(1) : "");
                    o.put("artist", artist);
                    o.put("album", album);
                    o.put("duration", c.getLong(4) / 1000.0);
                    o.put("tagged", true);
                    rows.add(o);
                }
            }
        } catch (Exception e) {
            reject(id, "기기 음악을 읽지 못했어요");
            return;
        }
        rows.sort((x, y) -> {
            int c = natCmp(x.optString("artist"), y.optString("artist"));
            if (c != 0) return c;
            c = natCmp(x.optString("album"), y.optString("album"));
            return c != 0 ? c : natCmp(x.optString("name"), y.optString("name"));
        });
        for (JSONObject o : rows) arr.put(o);
        resolve(id, arr.toString());
    }

    void handleIntent(Intent i) {
        if (i == null || !Intent.ACTION_VIEW.equals(i.getAction()) || i.getData() == null) return;
        final Uri u = i.getData();
        persist(u);
        JSONArray arr = new JSONArray();
        arr.put(item(u, displayName(u)));
        if (pageReady) js("window.__ullimOpen && window.__ullimOpen(" + JSONObject.quote(arr.toString()) + ")");
        else pendingOpen = arr.toString();
    }

    /* ---------------- 앱 파일 · 음악 스트리밍 ---------------- */
    static class Client extends WebViewClient {
        final MainActivity a;
        Client(MainActivity activity) { a = activity; }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (!HOST.equals(u.getHost())) return null;
            String path = u.getPath();
            if (path == null || path.isEmpty() || "/".equals(path)) path = "/index.html";
            if ("/media".equals(path)) return a.media(u.getQueryParameter("u"), req.getRequestHeaders());
            return a.asset(path);
        }

        @Override
        public boolean onRenderProcessGone(WebView v, android.webkit.RenderProcessGoneDetail detail) {
            // 화면 엔진이 종료돼도 앱이 꺼지지 않게: 새로 만들어 다시 띄운다
            a.main.post(a::recreate);
            return true;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (HOST.equals(u.getHost())) return false;
            try { a.startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) { /* noop */ }
            return true;
        }
    }

    static String mimeOf(String p) {
        p = p.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }

    static WebResourceResponse status(int code, String reason) {
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-cache");
        return new WebResourceResponse("text/plain", "utf-8", code, reason, h, new ByteArrayInputStream(new byte[0]));
    }

    WebResourceResponse asset(String path) {
        if (path.contains("..")) return status(403, "Forbidden");
        try {
            InputStream in = getAssets().open("www" + path);
            String mime = mimeOf(path);
            Map<String, String> h = new HashMap<>();
            h.put("Cache-Control", "no-cache");
            boolean text = mime.startsWith("text/") || mime.endsWith("json");
            return new WebResourceResponse(mime, text ? "utf-8" : null, 200, "OK", h, in);
        } catch (IOException e) {
            return status(404, "Not Found");
        }
    }

    WebResourceResponse media(String uriStr, Map<String, String> reqHeaders) {
        if (uriStr == null) return status(400, "Bad Request");
        AssetFileDescriptor afd = null;
        InputStream in = null;
        try {
            Uri uri = Uri.parse(uriStr);
            ContentResolver cr = getContentResolver();
            afd = cr.openAssetFileDescriptor(uri, "r");
            if (afd == null) return status(404, "Not Found");
            long size = afd.getLength();
            if (size < 0) size = afd.getParcelFileDescriptor().getStatSize();
            in = afd.createInputStream();
            String mime = cr.getType(uri);
            if (mime == null || !(mime.startsWith("audio/") || mime.startsWith("video/") || mime.contains("ogg") || mime.contains("flac"))) mime = guessMime(uriStr);
            String range = null;
            if (reqHeaders != null) for (Map.Entry<String, String> e : reqHeaders.entrySet()) if ("range".equalsIgnoreCase(e.getKey())) range = e.getValue();

            Map<String, String> h = new HashMap<>();
            h.put("Access-Control-Allow-Origin", "*");
            h.put("Cache-Control", "no-cache");
            // 크기를 모르는 스트림: 범위 요청 없이 그대로 (WebView 가 처음부터 읽음)
            if (size < 0) return new WebResourceResponse(mime, null, 200, "OK", h, in);
            h.put("Accept-Ranges", "bytes");

            long start = 0, end = size - 1;
            int code = 200;
            if (range != null && range.startsWith("bytes=")) {
                String r = range.substring(6).trim();
                int comma = r.indexOf(',');
                if (comma >= 0) r = r.substring(0, comma);
                int dash = r.indexOf('-');
                if (dash >= 0) {
                    String a = r.substring(0, dash).trim(), b = r.substring(dash + 1).trim();
                    try {
                        if (a.isEmpty() && !b.isEmpty()) start = Math.max(0, size - Long.parseLong(b));
                        else {
                            start = a.isEmpty() ? 0 : Long.parseLong(a);
                            if (!b.isEmpty()) end = Math.min(Long.parseLong(b), size - 1);
                        }
                        code = 206;
                    } catch (NumberFormatException ex) { start = 0; end = size - 1; code = 200; }
                }
                if (code == 206 && (start >= size || start > end)) {
                    in.close();
                    h.put("Content-Range", "bytes */" + size);
                    return new WebResourceResponse(mime, null, 416, "Range Not Satisfiable", h, new ByteArrayInputStream(new byte[0]));
                }
            }
            // WebView 가 요청의 Range 를 스스로 적용한다(스트림 available() 을 전체 크기로 보고 skip).
            // 그래서 여기서는 건너뛰지 않고 0..end 까지만 읽히게 하고, 상태 코드와 Content-Range 만 알려 준다.
            if (code == 206) h.put("Content-Range", "bytes " + start + "-" + end + "/" + size);
            return new WebResourceResponse(mime, null, code, code == 206 ? "Partial Content" : "OK", h, new Limited(in, end + 1));
        } catch (Exception e) {
            try { if (in != null) in.close(); } catch (Exception ignored) { /* noop */ }
            try { if (afd != null) afd.close(); } catch (Exception ignored) { /* noop */ }
            return status(404, "Not Found");
        }
    }

    static String guessMime(String s) {
        s = s.toLowerCase(Locale.ROOT);
        if (s.contains(".mp3")) return "audio/mpeg";
        if (s.contains(".flac")) return "audio/flac";
        if (s.contains(".m4a") || s.contains(".m4b") || s.contains(".mp4") || s.contains(".aac")) return "audio/mp4";
        if (s.contains(".ogg") || s.contains(".oga") || s.contains(".opus")) return "audio/ogg";
        if (s.contains(".wav")) return "audio/wav";
        if (s.contains(".webm") || s.contains(".weba")) return "audio/webm";
        return "application/octet-stream";
    }

    static class Limited extends FilterInputStream {
        long left;
        Limited(InputStream in, long n) { super(in); left = n; }
        @Override public int read() throws IOException {
            if (left <= 0) return -1;
            int b = super.read();
            if (b >= 0) left--;
            return b;
        }
        @Override public int read(byte[] b, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int n = super.read(b, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }
        @Override public long skip(long n) throws IOException {
            long s = super.skip(Math.min(n, left));
            if (s > 0) left -= s;
            return s;
        }
        @Override public int available() throws IOException { return (int) Math.min(super.available(), left); }
    }
}
