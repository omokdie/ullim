#!/usr/bin/env bash
# 울림 안드로이드 APK 빌드 (Gradle 없이 SDK 도구로 직접)
set -euo pipefail
ROOT=/home/claude/ullim
A=$ROOT/android
BT=${BT:-/home/claude/dl/x/bt/build-tools/34.0.4}
JAR=${JAR:-/home/claude/dl/x/sdk/android-sdk/platforms/android-33/android.jar}
OUT=$ROOT/build/android
VER=1.2.0
APK=$ROOT/dist/Ullim-$VER.apk

rm -rf "$OUT"; mkdir -p "$OUT"/{gen,classes,dex,assets/www} "$ROOT/dist" "$A/keystore"
cp -r "$ROOT"/web/* "$OUT/assets/www/"

echo "[1/7] 리소스 컴파일"
"$BT/aapt2" compile --dir "$A/res" -o "$OUT/res.zip"
echo "[2/7] 리소스 링크 + 매니페스트"
"$BT/aapt2" link -o "$OUT/base.apk" -I "$JAR" --manifest "$A/AndroidManifest.xml" --java "$OUT/gen" \
  -A "$OUT/assets" --min-sdk-version 24 --target-sdk-version 34 --version-code 6 --version-name "$VER" "$OUT/res.zip"
echo "[3/7] 자바 컴파일"
javac --release 8 -encoding UTF-8 -Xlint:-options -cp "$JAR" -d "$OUT/classes" $(find "$A/src" -name '*.java') $(find "$OUT/gen" -name '*.java') 2>&1 | grep -v JAVA_TOOL_OPTIONS || true
[ -f "$OUT/classes/kr/ullim/player/MainActivity.class" ] || { echo "javac failed"; exit 1; }
echo "[4/7] DEX 변환 (d8)"
java -cp "$BT/lib/d8.jar" com.android.tools.r8.D8 --release --min-api 24 --lib "$JAR" --output "$OUT/dex" $(find "$OUT/classes" -name '*.class') 2>&1 | grep -v JAVA_TOOL_OPTIONS || true
[ -f "$OUT/dex/classes.dex" ] || { echo "d8 failed"; exit 1; }
echo "[5/7] APK 조립"
cp "$OUT/base.apk" "$OUT/unsigned.apk"
(cd "$OUT/dex" && zip -q -j ../unsigned.apk classes.dex)
echo "[6/7] 정렬 (zipalign)"
"$BT/zipalign" -p -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
echo "[7/7] 서명 (apksigner v1+v2+v3)"
KS=$A/keystore/ullim-release.jks
PROPS=$A/keystore/keystore.properties
if [ ! -f "$KS" ]; then
  PASS=$(python3 -c "import secrets; print(secrets.token_urlsafe(18))")
  keytool -genkeypair -keystore "$KS" -storetype PKCS12 -storepass "$PASS" -keypass "$PASS" -alias ullim \
    -keyalg RSA -keysize 3072 -validity 10000 -dname "CN=Ullim, O=Ullim, C=KR" 2>&1 | grep -v JAVA_TOOL_OPTIONS || true
  printf 'storeFile=ullim-release.jks\nkeyAlias=ullim\nstorePassword=%s\nkeyPassword=%s\n' "$PASS" "$PASS" > "$PROPS"
fi
PASS=$(grep storePassword "$PROPS" | cut -d= -f2)
java -jar "$BT/lib/apksigner.jar" sign --ks "$KS" --ks-pass "pass:$PASS" --ks-key-alias ullim --out "$APK" "$OUT/aligned.apk" 2>&1 | grep -v JAVA_TOOL_OPTIONS || true
java -jar "$BT/lib/apksigner.jar" verify --verbose "$APK" 2>&1 | grep -v -E "JAVA_TOOL_OPTIONS|^WARNING: META-INF" || true
ls -la "$APK"
