package kr.ullim.player;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.drawable.Icon;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Base64;

import org.json.JSONObject;

/** 백그라운드 재생 유지 + 알림 · 잠금화면 · 이어폰 버튼 조작 */
public class PlaybackService extends Service {
    static PlaybackService inst;
    static String lastJson;
    static boolean stopRequested;
    static final String CH = "playback";
    static final int NID = 7;
    static final String A_TOGGLE = "kr.ullim.player.TOGGLE", A_NEXT = "kr.ullim.player.NEXT",
            A_PREV = "kr.ullim.player.PREV", A_CLOSE = "kr.ullim.player.CLOSE";

    MediaSession session;
    PowerManager.WakeLock wakeLock;
    boolean playing, hasTrack, noisyOn, closing;
    String title = "울림", artist = "", album = "";
    long pos, dur;
    Bitmap art;

    static class Noisy extends BroadcastReceiver {
        @Override public void onReceive(Context c, Intent i) {
            if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(i.getAction())) MainActivity.command("pause", null);
        }
    }
    static class Callback extends MediaSession.Callback {
        @Override public void onPlay() { MainActivity.command("play", null); }
        @Override public void onPause() { MainActivity.command("pause", null); }
        @Override public void onSkipToNext() { MainActivity.command("next", null); }
        @Override public void onSkipToPrevious() { MainActivity.command("prev", null); }
        @Override public void onSeekTo(long p) { MainActivity.command("seek", String.valueOf(p)); }
        @Override public void onStop() { MainActivity.command("pause", null); }
        @Override public void onCustomAction(String action, android.os.Bundle extras) {
            if ("close".equals(action)) { MainActivity.command("pause", null); if (inst != null) inst.shutdown(); }
        }
    }
    final BroadcastReceiver noisy = new Noisy();

    static void update(Context c, String json) {
        lastJson = json;
        PlaybackService s = inst;
        if (s != null && !s.closing) { s.apply(json); return; }
        try {
            JSONObject o = new JSONObject(json);
            if (o.optBoolean("hasTrack") && o.optBoolean("playing")) {
                stopRequested = false;
                Intent i = new Intent(c, PlaybackService.class);
                if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
            }
        } catch (Exception e) { /* noop */ }
    }

    static void stop(Context c) {
        if (inst != null) inst.shutdown();
        else stopRequested = true;   // 시작 중이면 startForeground 직후에 정리
    }

    @Override
    public void onCreate() {
        super.onCreate();
        inst = this;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CH, "재생 컨트롤", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            ch.setDescription("재생 중인 곡과 재생 버튼");
            getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
        session = new MediaSession(this, "Ullim");
        session.setCallback(new Callback());
        session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        session.setSessionActivity(openApp(1));
        session.setActive(true);
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ullim:playback");
        wakeLock.setReferenceCounted(false);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        closing = false;
        foreground();   // startForegroundService 뒤에는 무엇보다 먼저 호출해야 한다
        if (stopRequested) { stopRequested = false; shutdown(); return START_NOT_STICKY; }
        if (lastJson != null) apply(lastJson);
        String a = intent != null ? intent.getAction() : null;
        if (A_TOGGLE.equals(a)) MainActivity.command("toggle", null);
        else if (A_NEXT.equals(a)) MainActivity.command("next", null);
        else if (A_PREV.equals(a)) MainActivity.command("prev", null);
        else if (A_CLOSE.equals(a)) { MainActivity.command("pause", null); shutdown(); }
        return START_NOT_STICKY;
    }

    void apply(String json) {
        if (closing) return;
        try {
            JSONObject o = new JSONObject(json);
            hasTrack = o.optBoolean("hasTrack");
            playing = o.optBoolean("playing");
            title = o.optString("title", "울림");
            artist = o.optString("artist", "");
            album = o.optString("album", "");
            pos = o.optLong("position", 0);
            dur = o.optLong("duration", 0);
            if (o.has("art")) art = decode(o.optString("art", ""));
        } catch (Exception e) { /* keep previous */ }
        if (!hasTrack) { shutdown(); return; }
        if (!session.isActive()) session.setActive(true);
        MediaMetadata.Builder mb = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, album)
                .putLong(MediaMetadata.METADATA_KEY_DURATION, dur);
        if (art != null) mb.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, art);
        session.setMetadata(mb.build());
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
                | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_SEEK_TO | PlaybackState.ACTION_STOP;
        session.setPlaybackState(new PlaybackState.Builder().setActions(actions)
                .addCustomAction(new PlaybackState.CustomAction.Builder("close", "닫기", android.R.drawable.ic_menu_close_clear_cancel).build())
                .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, pos, playing ? 1f : 0f, SystemClock.elapsedRealtime())
                .build());
        if (playing) {
            if (!wakeLock.isHeld()) wakeLock.acquire(6L * 60 * 60 * 1000);
            noisy(true);
        } else {
            if (wakeLock.isHeld()) wakeLock.release();
            noisy(false);
        }
        foreground();
    }

    void foreground() {
        try {
            Notification n = build();
            if (Build.VERSION.SDK_INT >= 29) startForeground(NID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            else startForeground(NID, n);
        } catch (Exception e) { /* not allowed right now — keep playing without notification */ }
    }

    PendingIntent openApp(int code) {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, code, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    Notification.Action act(int icon, String label, String action, int code) {
        Intent i = new Intent(this, PlaybackService.class).setAction(action);
        PendingIntent pi = PendingIntent.getService(this, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Action.Builder(Icon.createWithResource(this, icon), label, pi).build();
    }

    Notification build() {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CH) : new Notification.Builder(this);
        b.setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(title)
                .setContentText(artist.isEmpty() ? album : artist)
                .setContentIntent(openApp(2))
                .setOngoing(playing)
                .setShowWhen(false)
                .setOnlyAlertOnce(true)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setCategory(Notification.CATEGORY_TRANSPORT);
        if (art != null) b.setLargeIcon(art);
        b.addAction(act(android.R.drawable.ic_media_previous, "이전 곡", A_PREV, 10));
        b.addAction(act(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play, playing ? "일시정지" : "재생", A_TOGGLE, 11));
        b.addAction(act(android.R.drawable.ic_media_next, "다음 곡", A_NEXT, 12));
        b.addAction(act(android.R.drawable.ic_menu_close_clear_cancel, "닫기", A_CLOSE, 13));
        b.setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0, 1, 2));
        if (Build.VERSION.SDK_INT >= 31) b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        return b.build();
    }

    static Bitmap decode(String s) {
        if (s == null || s.isEmpty()) return null;
        try {
            int c = s.indexOf(',');
            byte[] b = Base64.decode(c >= 0 ? s.substring(c + 1) : s, Base64.DEFAULT);
            return BitmapFactory.decodeByteArray(b, 0, b.length);
        } catch (Exception e) {
            return null;
        }
    }

    void noisy(boolean on) {
        if (on && !noisyOn) {
            IntentFilter f = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
            if (Build.VERSION.SDK_INT >= 33) registerReceiver(noisy, f, Context.RECEIVER_NOT_EXPORTED);
            else registerReceiver(noisy, f);
            noisyOn = true;
        } else if (!on && noisyOn) {
            try { unregisterReceiver(noisy); } catch (Exception e) { /* noop */ }
            noisyOn = false;
        }
    }

    void shutdown() {
        closing = true;
        noisy(false);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (session != null) session.setActive(false);
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        shutdown();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        noisy(false);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (session != null) session.release();
        if (inst == this) inst = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
