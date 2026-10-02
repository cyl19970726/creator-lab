#!/usr/bin/env bash
# Creation-owned render + verify contract. Usage: bash tooling/render-episode.sh [episode dir] [--cover-at <sec>] [--quality high]
# Verify duration, 1080×1920@30, audio, and a nonblack settled cover. The first frame may already be visible.
# 教训：EP01 cover 生成了没传；EP02 "停掉正在跑的旧版渲染" 时渲染 23 分钟前已完成。
set -euo pipefail
DIR="."; COVER_AT=""; QUALITY="high"; SKIP_RENDER=0
while [ $# -gt 0 ]; do case "$1" in --cover-at) COVER_AT="$2"; shift 2;; --quality) QUALITY="$2"; shift 2;; --skip-render) SKIP_RENDER=1; shift;; *) DIR="$1"; shift;; esac; done
# ── stale-frames gate: any frame html newer than retime-report.json means frames were rebuilt after retime → timings/settle out of sync (EP02 真跑事故：B09/B10/B13 上屏空白) ──
if [ "$SKIP_RENDER" = 0 ] && [ -f "$DIR/retime-report.json" ]; then
  stale=$(find "$DIR/compositions/frames" -name '*.html' -newer "$DIR/retime-report.json" | wc -l | tr -d ' ')
  if [ "$stale" != 0 ]; then echo "refuse: $stale frame(s) rebuilt after last retime — run retime-to-minimax.mjs first" >&2; exit 3; fi
fi
cd "$DIR"
NAME="$(python3 -c 'import json;print(json.load(open("package.json"))["name"])')"
mkdir -p exports
OUT="exports/$NAME.mp4"
rm -f "exports/$NAME.done"
if [ "$SKIP_RENDER" = 0 ]; then
  echo $$ > exports/.render.pid
  npx --yes hyperframes@0.8.27 render . -q "$QUALITY" -o "$OUT" 2>&1 | tee "exports/$NAME.render.log"
  rm -f exports/.render.pid
fi
[ -f "$OUT" ] || { echo "render produced no file" >&2; exit 1; }

# ── verify ────────────────────────────────────────────────────────────────────
TOTAL="$(python3 -c 'import json;print(json.load(open("retime-report.json"))["total"])' 2>/dev/null || echo "")"
DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")"
WH="$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate -of csv=p=0 "$OUT")"
AUD="$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "$OUT" || true)"
fail=0
chk() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
chk "duration $DUR ≈ retime total ${TOTAL:-?}" "python3 -c \"import sys; t='$TOTAL'; sys.exit(0 if t=='' or abs(float('$DUR')-float(t))<=0.5 else 1)\""
chk "1080x1920@30 ($WH)"                      "[[ '$WH' == 1080,1920,30/1* ]]"
chk "audio stream ($AUD)"                     "[ -n '$AUD' ]"

# ── cover ─────────────────────────────────────────────────────────────────────
if [ -z "$COVER_AT" ]; then
  COVER_AT="$(python3 - <<'PY'
import json,re
try:
    rep=json.load(open('retime-report.json'))
    sb=open('STORYBOARD.md').read() if __import__('os').path.exists('STORYBOARD.md') else ''
    m=re.search(r'cover_beat:\s*(\d+)', sb) or re.search(r'climax_beat:\s*(\d+)', sb)
    idx=int(m.group(1))-1 if m else rep['names'].index(next(n for n in rep['names'] if 'hook' in n))
    print(rep['settle'][idx])
except Exception as e:
    print('')
PY
)"
fi
[ -n "$COVER_AT" ] || { echo "FAIL cover: no --cover-at and no STORYBOARD cover_beat/climax_beat" >&2; exit 1; }
chk "cover after fade-in (t=$COVER_AT ≥ 1.5 s)" "python3 -c \"import sys; sys.exit(0 if float('$COVER_AT')>=1.5 else 1)\""
rm -rf exports/.cover && mkdir -p exports/.cover
npx --yes hyperframes@0.8.27 snapshot . --at "0,$COVER_AT" --no-end -o exports/.cover >/dev/null
# 系列底色是深海军蓝，平均亮度不可用；用"亮像素占比"（Y>110）检查稳定封面。
bright() { ffmpeg -v error -i "$1" -vf "format=gray,lutyuv=y='if(gt(val,110),255,0)',signalstats,metadata=print:file=-" -f null - 2>/dev/null | grep -o 'YAVG=[0-9.]*' | head -1 | cut -d= -f2; }
F0="$(ls exports/.cover/*.png | sort | head -1)"; FC="$(ls exports/.cover/*.png | sort | tail -1)"
cp "$FC" exports/cover.png
B0="$(python3 -c "print(round(float('$(bright "$F0")')/255*100,2))")"; BC="$(python3 -c "print(round(float('$(bright "$FC")')/255*100,2))")"
chk "cover bright-pixel fraction ${BC}% ≥ 1.5% (first frame ${B0}%)" "python3 -c \"import sys; bc=float('$BC'); sys.exit(0 if bc>=1.5 else 1)\""
[ "$fail" = 0 ] || { echo "verify FAILED — no done marker written" >&2; exit 1; }
if python3 -c 'import json,sys; sys.exit(0 if json.load(open("assets/voice-minimax/manifest.json")).get("placeholder") else 1)' 2>/dev/null; then
  echo "PLACEHOLDER VOICE — pipeline-validation render only; no .done marker (re-record with scripts/tts.sh before publishing)"
  exit 0
fi
shasum -a 256 "$OUT" | cut -d' ' -f1 > "exports/$NAME.done"
echo "DONE $OUT ($DUR s) cover=exports/cover.png@${COVER_AT}s marker=exports/$NAME.done"
