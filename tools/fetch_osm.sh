#!/usr/bin/env bash
# 从 Overpass 镜像下载米兰市中心的 OSM 数据到 data/raw/（顺序执行，带重试）
set -u
cd "$(dirname "$0")/.." || exit 1
mkdir -p data/raw
BBOX="45.450,9.160,45.490,9.220"
EP="https://overpass.kumi.systems/api/interpreter"
UA="Mozilla/5.0 (Windows NT 10.0) MapRoutingTutorial/1.0"
LOG=data/raw/fetch.log
: > "$LOG"

fetch() {
  local name="$1" body="$2" out="data/raw/$1.json"
  for attempt in 1 2 3; do
    echo "[$(date +%T)] $name attempt $attempt" >> "$LOG"
    curl -sS -m 900 -A "$UA" -H "Accept: application/json" -o "$out" \
      --data-urlencode "data=[out:json][timeout:600];($body);out body;>;out skel qt;" "$EP"
    if head -c 200 "$out" | grep -q '"version"'; then
      echo "[$(date +%T)] $name ok $(stat -c %s "$out") bytes" >> "$LOG"
      return 0
    fi
    echo "[$(date +%T)] $name failed: $(head -c 200 "$out" | tr -d '\n')" >> "$LOG"
    sleep 20
  done
  return 1
}

fetch roads "way[\"highway\"~\"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|pedestrian)\$\"]($BBOX);"
fetch landuse "way[\"natural\"=\"water\"]($BBOX);relation[\"natural\"=\"water\"]($BBOX);way[\"waterway\"~\"^(river|canal)\$\"]($BBOX);way[\"leisure\"~\"^(park|garden|pitch|playground)\$\"]($BBOX);relation[\"leisure\"~\"^(park|garden)\$\"]($BBOX);way[\"landuse\"~\"^(grass|forest|cemetery|railway)\$\"]($BBOX);relation[\"landuse\"=\"cemetery\"]($BBOX);way[\"railway\"~\"^(rail|light_rail)\$\"]($BBOX);node[\"railway\"=\"station\"]($BBOX);node[\"tourism\"~\"^(attraction|museum)\$\"]($BBOX);node[\"place\"=\"square\"]($BBOX);way[\"place\"=\"square\"]($BBOX);node[\"historic\"~\"^(castle|monument|church)\$\"]($BBOX);"
fetch buildings "way[\"building\"]($BBOX);"
echo "[$(date +%T)] all done" >> "$LOG"
