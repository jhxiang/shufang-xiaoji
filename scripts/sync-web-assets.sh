#!/usr/bin/env bash
# 把 Web 端资源同步进 iOS 工程（WebApp 目录会被打包为 bundle 资源）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/ios/ShufangXiaoji/WebApp"

mkdir -p "$DEST"

FILES=(
  index.html
  styles.css
  app.js
  catalog.js
  audio.js
  mindmap.js
  manifest.webmanifest
  icon.svg
  icon-180.png
  icon-192.png
  icon-512.png
)

for f in "${FILES[@]}"; do
  if [ -f "$ROOT/$f" ]; then
    cp -f "$ROOT/$f" "$DEST/$f"
  else
    echo "缺少资源文件: $f" >&2
    exit 1
  fi
done

# 原生壳内不需要 Service Worker 缓存（离线由本地 bundle 保证）
rm -f "$DEST/sw.js"

# 同时拷贝 AppIcon 到 Assets
cp -f "$ROOT/AppIcon-1024.png" "$ROOT/ios/ShufangXiaoji/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png"

echo "已同步 $((${#FILES[@]})) 个 Web 资源到 $DEST"
