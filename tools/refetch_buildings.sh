#!/usr/bin/env bash
# 重新下载建筑原始数据（仅用于以后重建 data/milan.js；页面本身不需要）
cd "$(dirname "$0")/.." || exit 1
for i in 1 2 3 4 5 6; do
  curl -sS -m 600 -A "Mozilla/5.0 (Windows NT 10.0) MapRoutingTutorial/1.0" -H "Accept: application/json" -o data/raw/buildings.json \
    --data-urlencode 'data=[out:json][timeout:600];(way["building"](45.450,9.160,45.490,9.220););out body;>;out skel qt;' \
    https://maps.mail.ru/osm/tools/overpass/api/interpreter
  if head -c 100 data/raw/buildings.json | grep -q '"version"' && python -I -c "import json;json.load(open('data/raw/buildings.json',encoding='utf-8'))" 2>/dev/null; then
    echo "[$(date +%T)] buildings ok $(stat -c %s data/raw/buildings.json) bytes" >> data/raw/fetch.log; exit 0
  fi
  echo "[$(date +%T)] buildings retry $i: $(head -c 120 data/raw/buildings.json | tr -d '\n')" >> data/raw/fetch.log
  sleep 60
done
exit 1
