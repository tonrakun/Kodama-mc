#!/usr/bin/env bash
# Starts a Kodama server with the recommended JVM flags.
#
#   ./start.sh                     G1, 4G heap, newest kodama-paperclip-*.jar in this directory
#   MEMORY=10G GC=zgc ./start.sh   generational ZGC, 10G heap
#
# Environment: MEMORY (heap, default 4G), GC (g1 | zgc, default g1), JAVA (java binary),
# JAR (server jar), EXTRA_JVM_ARGS. Arguments are passed to the server.
set -euo pipefail
cd "$(dirname "$0")"

MEMORY="${MEMORY:-4G}"
GC="${GC:-g1}"
JAVA="${JAVA:-${JAVA_HOME:+$JAVA_HOME/bin/}java}"
JAR="${JAR:-$(ls -t kodama-paperclip-*.jar 2>/dev/null | head -n 1)}"

if [ -z "$JAR" ] || [ ! -f "$JAR" ]; then
  echo "No server jar found. Put kodama-paperclip-*.jar next to this script or set JAR." >&2
  exit 1
fi

version_line="$("$JAVA" -version 2>&1 | head -n 1)"
java_major="$(echo "$version_line" | sed -E 's/.*version "([0-9]+).*/\1/')"
if ! [ "$java_major" -ge 21 ] 2>/dev/null; then
  echo "Java 21 or newer is required, found: $version_line" >&2
  exit 1
fi

heap_gb() {
  local v="${MEMORY%[GgMm]}"
  case "$MEMORY" in
    *[Mm]) echo $((v / 1024)) ;;
    *) echo "$v" ;;
  esac
}

flags=("-Xms$MEMORY" "-Xmx$MEMORY" -XX:+AlwaysPreTouch -XX:+DisableExplicitGC -XX:+PerfDisableSharedMem)

case "$GC" in
  g1)
    # Aikar's flags; the young generation and regions grow with the heap above 12G
    if [ "$(heap_gb)" -gt 12 ]; then
      young=(-XX:G1NewSizePercent=40 -XX:G1MaxNewSizePercent=50 -XX:G1HeapRegionSize=16M -XX:G1ReservePercent=15 -XX:InitiatingHeapOccupancyPercent=20)
    else
      young=(-XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -XX:InitiatingHeapOccupancyPercent=15)
    fi
    flags+=(-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions
      "${young[@]}" -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:G1MixedGCLiveThresholdPercent=90
      -XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:MaxTenuringThreshold=1)
    ;;
  zgc)
    flags+=(-XX:+UseZGC)
    # generational is the only mode from JDK 23; before that it has to be asked for
    if [ "$java_major" -lt 23 ]; then flags+=(-XX:+ZGenerational); fi
    ;;
  *)
    echo "GC must be g1 or zgc, got: $GC" >&2
    exit 1
    ;;
esac

if [ "$java_major" -ge 25 ]; then
  flags+=(-XX:+UseCompactObjectHeaders)
elif [ "$java_major" -eq 24 ]; then
  flags+=(-XX:+UnlockExperimentalVMOptions -XX:+UseCompactObjectHeaders)
fi

# shellcheck disable=SC2206
extra=(${EXTRA_JVM_ARGS:-})
exec "$JAVA" "${flags[@]}" "${extra[@]}" -jar "$JAR" --nogui "$@"
