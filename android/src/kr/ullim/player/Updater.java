package kr.ullim.player;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.os.Build;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 울림 — 자동 업데이트 (안드로이드)
 *  1) 화면(web/js/update.js)이 GitHub 의 update/latest.json 을 읽고 새 버전이 있으면 download() 를 부탁한다.
 *     이 저장소 릴리스의 'v<버전>/Ullim-<버전>.apk' 만 받고, 크기 · SHA-256 · 패키지 이름 · 버전 번호가 맞을 때만 준비됨.
 *  2) [설치]를 누르면 PackageInstaller 로 설치한다. 처음 한 번은 '이 출처 허용' 설정이 필요하고,
 *     안드로이드 12 이상에서는 그다음부터 확인 창 없이 설치된다 (그보다 낮으면 안드로이드 확인 창에서 [업데이트]).
 *  3) 설치가 끝나 앱이 새 버전으로 바뀌면 알림으로 알려 준다 (눌러서 다시 열기).
 */
public final class Updater {
    static final Pattern URL_RE = Pattern.compile("^https://github\\.com/omokdie/ullim/releases/download/v(\\d+\\.\\d+\\.\\d+)/Ullim-(\\d+\\.\\d+\\.\\d+)\\.apk$");
    static final Pattern NAME_RE = Pattern.compile("^ullim-(\\d+\\.\\d+\\.\\d+)\\.apk$");
    static final String ACTION_STATUS = "kr.ullim.player.UPDATE_STATUS";
    static final String CHANNEL = "update";
    static final int NOTIFY_ID = 77;

    static volatile File ready;            // 받아서 확인까지 끝난 APK
    static volatile String readyVersion;
    static volatile int quietSession = -1;  // 확인 창 없이만 설치하려던 세션 (확인이 필요하다고 하면 취소)

    private Updater() {}

    static File dir(Context c) { return new File(c.getCacheDir(), "update"); }
    static File mark(Context c) { return new File(c.getFilesDir(), "update-committed"); }

    static long currentVersionCode(Context c) {
        try {
            PackageInfo p = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode;
        } catch (Exception e) { return 0; }
    }
    static String currentVersionName(Context c) {
        try { return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionName; } catch (Exception e) { return "0.0.0"; }
    }
    static boolean newer(String a, String b) {
        String[] pa = String.valueOf(a).split("\\."), pb = String.valueOf(b).split("\\.");
        for (int i = 0; i < 3; i++) {
            int x = i < pa.length ? num(pa[i]) : 0, y = i < pb.length ? num(pb[i]) : 0;
            if (x != y) return x > y;
        }
        return false;
    }
    static int num(String s) { try { return Integer.parseInt(s); } catch (Exception e) { return 0; } }

    static String hex(byte[] d) {
        StringBuilder sb = new StringBuilder(d.length * 2);
        for (byte b : d) sb.append(String.format(Locale.ROOT, "%02x", b & 0xff));
        return sb.toString();
    }
    static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        }
        return hex(md.digest());
    }

    /** 새 버전 APK 받기 → 확인. 지난번에 받아 둔 같은 파일이 있으면 다시 받지 않는다. */
    static synchronized void download(Context c, String url, String sha, long size, String version, String ua) throws Exception {
        Matcher m = url == null ? null : URL_RE.matcher(url);
        if (m == null || !m.matches() || !m.group(1).equals(version) || !m.group(2).equals(version)) throw new Exception("bad url");
        if (sha == null || !sha.matches("[0-9a-f]{64}") || size <= 0 || size >= 400000000L) throw new Exception("bad update");
        if (!newer(version, currentVersionName(c))) throw new Exception("not newer");
        File d = dir(c);
        if (!d.isDirectory() && !d.mkdirs()) throw new Exception("no dir");
        File out = new File(d, "ullim-" + version + ".apk");
        if (out.isFile() && out.length() == size && sha.equals(sha256(out))) {
            check(c, out);
            ready = out; readyVersion = version;
            return;
        }
        File part = new File(d, "download.part");
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();   // GitHub → 파일 저장소(https) 로 넘겨주기는 알아서 따라감
        try {
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            conn.setRequestProperty("User-Agent", ua);
            int code = conn.getResponseCode();
            if (code != 200) throw new Exception("http " + code);
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            long got = 0;
            try (InputStream in = conn.getInputStream(); OutputStream os = new FileOutputStream(part)) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) {
                    got += n;
                    if (got > size) throw new Exception("size");
                    md.update(buf, 0, n);
                    os.write(buf, 0, n);
                }
            }
            if (got != size || !sha.equals(hex(md.digest()))) throw new Exception("verify");
            if (out.exists() && !out.delete()) throw new Exception("replace");
            if (!part.renameTo(out)) throw new Exception("rename");
        } catch (Exception e) {
            part.delete();
            throw e;
        } finally {
            conn.disconnect();
        }
        check(c, out);
        ready = out; readyVersion = version;
    }

    /** 받은 파일이 울림의 더 새 버전인지 (다른 앱이거나 같은/옛 버전이면 지움) */
    static void check(Context c, File f) throws Exception {
        PackageInfo p = c.getPackageManager().getPackageArchiveInfo(f.getPath(), 0);
        long vc = p == null ? 0 : (Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode);
        if (p == null || !c.getPackageName().equals(p.packageName) || vc <= currentVersionCode(c)) {
            f.delete();
            throw new Exception("bad apk");
        }
    }

    /**
     * 설치 시작 → "started" | "need-permission" | "skip".
     * quietOnly: 확인 창 없이 설치할 수 있을 때만 (안드로이드 12+ · '이 출처 허용' 켜짐). 아니면 아무것도 하지 않음.
     */
    static String install(MainActivity a, boolean quietOnly) throws Exception {
        File f = ready;
        String v = readyVersion;
        if (f == null || !f.isFile() || v == null) throw new Exception("no update");
        if (Build.VERSION.SDK_INT >= 26 && !a.getPackageManager().canRequestPackageInstalls()) {
            if (quietOnly) return "skip";
            a.main.post(a::openInstallPermission);
            return "need-permission";
        }
        if (quietOnly && Build.VERSION.SDK_INT < 31) return "skip";
        commit(a.getApplicationContext(), f, v, quietOnly);
        return "started";
    }

    static void commit(Context c, File f, String version, boolean quietOnly) throws Exception {
        PackageInstaller pi = c.getPackageManager().getPackageInstaller();
        abandonAll(pi);
        PackageInstaller.SessionParams p = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        p.setAppPackageName(c.getPackageName());
        p.setSize(f.length());
        if (Build.VERSION.SDK_INT >= 31) p.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        int sid = pi.createSession(p);
        PackageInstaller.Session s = pi.openSession(sid);
        try {
            try (InputStream in = new FileInputStream(f); OutputStream out = s.openWrite("ullim.apk", 0, f.length())) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                s.fsync(out);
            }
            quietSession = quietOnly ? sid : -1;
            writeMark(c, version);
            Intent i = new Intent(c, StatusReceiver.class).setAction(ACTION_STATUS);
            // 설치 결과를 시스템이 채워 넣어야 하므로 수정 가능한 PendingIntent (받는 곳은 이 앱의 내부 수신기로 고정)
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            s.commit(PendingIntent.getBroadcast(c, 1, i, flags).getIntentSender());
        } catch (Exception e) {
            try { s.abandon(); } catch (Exception ignored) { /* noop */ }
            mark(c).delete();
            throw e;
        } finally {
            s.close();
        }
    }

    static void abandonAll(PackageInstaller pi) {
        try {
            for (PackageInstaller.SessionInfo si : pi.getMySessions()) {
                try { pi.abandonSession(si.getSessionId()); } catch (Exception e) { /* noop */ }
            }
        } catch (Exception e) { /* noop */ }
    }

    static void writeMark(Context c, String version) {
        try (OutputStream os = new FileOutputStream(mark(c))) { os.write(version.getBytes(StandardCharsets.UTF_8)); } catch (Exception e) { /* noop */ }
    }
    static String readMark(Context c) {
        File f = mark(c);
        if (!f.isFile() || f.length() > 64) return null;
        try (InputStream in = new FileInputStream(f)) {
            byte[] b = new byte[(int) f.length()];
            int n = in.read(b);
            return n > 0 ? new String(b, 0, n, StandardCharsets.UTF_8).trim() : null;
        } catch (Exception e) { return null; }
    }

    /** 자동 업데이트를 끄면 받아 둔 파일도 지운다 */
    static synchronized void discard(Context c) {
        ready = null; readyVersion = null;
        File[] fs = dir(c).listFiles();
        if (fs != null) for (File f : fs) f.delete();
    }

    /** 앱을 열 때: 지금 버전 이하의 APK · 받다 만 파일 · 남은 설치 세션 정리 */
    static synchronized void cleanup(Context c) {
        String cur = currentVersionName(c);
        File[] fs = dir(c).listFiles();
        if (fs != null) {
            for (File f : fs) {
                Matcher m = NAME_RE.matcher(f.getName());
                if (!m.matches() || !newer(m.group(1), cur)) f.delete();
            }
        }
        abandonAll(c.getPackageManager().getPackageInstaller());
    }

    /** 설치 결과 (시스템 → 이 앱만) */
    public static class StatusReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context c, Intent i) {
            int st = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
            int sid = i.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1);
            MainActivity a = MainActivity.instance;
            if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                Intent confirm = i.getParcelableExtra(Intent.EXTRA_INTENT);
                // 화면을 보면서 [설치]를 누른 경우에만 안드로이드 확인 창을 띄운다
                // (조용히 설치하려던 경우나 앱이 뒤로 가 있으면 취소하고, 다음에 [설치]를 누르면 다시)
                if (confirm != null && sid != quietSession && a != null && a.resumed) {
                    try { a.startActivity(confirm); return; } catch (Exception e) { /* 아래에서 취소 */ }
                }
                try { c.getPackageManager().getPackageInstaller().abandonSession(sid); } catch (Exception e) { /* noop */ }
                mark(c).delete();
                if (a != null) a.js("window.__ullimUpdateResult && window.__ullimUpdateResult(-1)");
                return;
            }
            if (st != PackageInstaller.STATUS_SUCCESS) mark(c).delete();
            if (a != null) a.js("window.__ullimUpdateResult && window.__ullimUpdateResult(" + st + ")");
        }
    }

    /** 새 버전으로 바뀐 뒤 (시스템이 이 앱에만 보냄): 받은 파일을 지우고, 울림이 시작한 업데이트였으면 알림 */
    public static class ReplacedReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context c, Intent i) {
            if (!Intent.ACTION_MY_PACKAGE_REPLACED.equals(i.getAction())) return;
            String marked = readMark(c);
            mark(c).delete();
            cleanup(c);
            String ver = currentVersionName(c);
            if (marked == null || !marked.equals(ver)) return;
            try {
                NotificationManager nm = c.getSystemService(NotificationManager.class);
                if (nm == null) return;
                if (Build.VERSION.SDK_INT >= 26) {
                    NotificationChannel ch = new NotificationChannel(CHANNEL, "업데이트", NotificationManager.IMPORTANCE_LOW);
                    ch.setDescription("새 버전으로 업데이트했을 때 알려 줘요");
                    ch.setShowBadge(false);
                    nm.createNotificationChannel(ch);
                }
                Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                PendingIntent pi = PendingIntent.getActivity(c, 20, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
                Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, CHANNEL) : new Notification.Builder(c);
                b.setSmallIcon(R.drawable.ic_stat)
                    .setContentTitle("울림을 " + ver + "(으)로 업데이트했어요")
                    .setContentText("눌러서 다시 열기")
                    .setContentIntent(pi)
                    .setAutoCancel(true);
                nm.notify(NOTIFY_ID, b.build());
            } catch (Exception e) { /* 알림 권한 없음 등 */ }
        }
    }
}
