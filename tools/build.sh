#!/usr/bin/env bash
# build.sh — 从源码构建 LexiGlass APK（不依赖 Android Studio / Gradle）
#
# 依赖（Windows，路径可在脚本顶部改）：
#   Android SDK build-tools（aapt2 / zipalign / d8 / apksigner）
#   android.jar（platforms/android-35）
#   JDK 11+（JBR / OpenJDK，含 keytool）
#   python3（仅组装 APK 时追加 classes.dex 用）
#
# 用法：
#   bash tools/build.sh [输出路径]
#   默认输出 out/LexiGlass-1.0.0.apk
#
# 数据（法规全文）不进仓库，用 tools/crawl_local.py 抓取后自动落到
# app/assets/web/data/，构建时一并打进 APK。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/app"
OUT="${1:-$ROOT/out/LexiGlass-1.0.0.apk}"

BT="E:/Android-Studio-components/Android/SDK/build-tools/36.0.0"
ANDROID_JAR="E:/Android-Studio-components/Android/SDK/platforms/android-35/android.jar"
JAVA_HOME="${JAVA_HOME:-E:/Android Studio/jbr}"
KEYSTORE="${KEYSTORE:-$ROOT/tools/lexiglass.keystore}"
KS_PASS="${KS_PASS:-lexiglass}"
KS_ALIAS="lexiglass"

WORK="$(mktemp -d)"
mkdir -p "$ROOT/out" "$ROOT/build"

echo "== 1/6 aapt2 编译资源 =="
"$BT/aapt2.exe" compile --dir "$APP/res" -o "$WORK/res.zip"

echo "== 2/6 aapt2 链接（含 assets + manifest） =="
"$BT/aapt2.exe" link -o "$WORK/base.apk" \
  -I "$ANDROID_JAR" \
  --manifest "$APP/AndroidManifest.xml" \
  -R "$WORK/res.zip" \
  --auto-add-overlay \
  -A "$APP/assets" \
  --java "$WORK/gen" >/dev/null

echo "== 3/6 javac 编译 MainActivity =="
"$JAVA_HOME/bin/javac.exe" --release 11 -encoding UTF-8 -Xlint:-options \
  -cp "$ANDROID_JAR" -d "$WORK/classes" \
  $(find "$APP/src" -name '*.java')

echo "== 4/6 d8 生成 classes.dex =="
mkdir -p "$WORK/dex"
"$JAVA_HOME/bin/java.exe" -cp "$BT/lib/d8.jar" com.android.tools.r8.D8 \
  --min-api 24 --release --lib "$ANDROID_JAR" --output "$WORK/dex" \
  $(find "$WORK/classes" -name '*.class')

echo "== 5/6 组装 APK（追加 classes.dex + 对齐） =="
python - "$WORK" <<'PY'
import sys, os, zipfile, zlib, struct

work = sys.argv[1]
base = os.path.join(work, "base.apk")
dex = os.path.join(work, "dex", "classes.dex")
merged = os.path.join(work, "merged.apk")
aligned = os.path.join(work, "aligned.apk")

zin = zipfile.ZipFile(base)
zout = zipfile.ZipFile(merged, "w", zipfile.ZIP_DEFLATED, compresslevel=9)
for info in zin.infolist():
    if info.filename == "classes.dex":
        continue
    data = zin.read(info.filename)
    # resources.arsc 必须 STORED（未压缩），其余保持原样
    compress = zipfile.ZIP_STORED if info.filename == "resources.arsc" else zipfile.ZIP_DEFLATED
    zout.writestr(info.filename, data, compress_type=compress)
zout.write(dex, "classes.dex", compress_type=zipfile.ZIP_DEFLATED)
zout.close()
zin.close()
print("merged:", os.path.getsize(merged), "bytes")
PY

"$BT/zipalign.exe" -f 4 "$WORK/merged.apk" "$WORK/aligned.apk" >/dev/null

echo "== 6/6 签名（v2） =="
if [ ! -f "$KEYSTORE" ]; then
  "$JAVA_HOME/bin/keytool.exe" -genkeypair -v -keystore "$KEYSTORE" \
    -alias "$KS_ALIAS" -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=LexiGlass, OU=Open Source, O=LexiGlass, L=Internet, C=CN" >/dev/null 2>&1
fi
"$BT/apksigner.bat" sign --ks "$KEYSTORE" --ks-pass "pass:$KS_PASS" \
  --ks-key-alias "$KS_ALIAS" --out "$OUT" "$WORK/aligned.apk" >/dev/null

echo
echo "== 校验 =="
"$BT/apksigner.bat" verify --print-certs "$OUT" 2>&1 | head -4
echo
echo "输出：$OUT"
echo "安装：adb install -r \"$OUT\""
