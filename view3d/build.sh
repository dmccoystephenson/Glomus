#!/usr/bin/env bash
# Builds the 3D view's engine into game/3d/ with Strata's web kit, against a pinned Strata release.
# Only needed to change view3d/glomus3d.cpp: playing uses the built files already in game/3d/.
#
#   1. Install emsdk 6.0.11 and activate it (`./emsdk install 6.0.11 && ./emsdk activate 6.0.11`,
#      then `source ./emsdk_env.sh`). Its emcc needs Python 3.10 or later.
#   2. bash view3d/build.sh
#
# It downloads Strata's 0.9.0 web release once into view3d/.build/, checks it against the SHA-256 below,
# and runs the kit's build-kit.sh from it. Set STRATA_KIT to use another build-kit.sh instead. The same
# inputs build the same bytes, so `cd game/3d && sha256sum -c SHA256SUMS` confirms a rebuild matches.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export KIT_SOURCE="$here/glomus3d.cpp"
export KIT_OUT="$here/../game/3d"
export KIT_NAME=glomus3d
export KIT_EXPORT_NAME=createGlomus3d
export KIT_EXPORTS=_g3_set_ground,_g3_set_water,_g3_set_marks,_g3_set_lines,_g3_set_wide_lines,_g3_set_sky,_g3_set_lights,_g3_set_points,_g3_set_body,_g3_pose_bodies
export KIT_WORK="${KIT_WORK:-$here/.build}"
export STRATA_VERSION=0.9.0
export STRATA_SHA256=c0792999fb9718c37a38d0addf85334cbcd7c50fa0d4cc62f084c3b466969fc9
if [ -z "${STRATA_KIT:-}" ]; then
  mkdir -p "$KIT_WORK"
  export STRATA_TARBALL="$KIT_WORK/strata-$STRATA_VERSION-wasm32-emscripten.tar.gz"
  if [ ! -f "$STRATA_TARBALL" ]; then
    curl -fsSL -o "$STRATA_TARBALL.part" \
      "https://github.com/Preponderous-Software/strata/releases/download/v$STRATA_VERSION/strata-$STRATA_VERSION-wasm32-emscripten.tar.gz"
    mv "$STRATA_TARBALL.part" "$STRATA_TARBALL"
  fi
  echo "$STRATA_SHA256  $STRATA_TARBALL" | sha256sum -c --quiet -
  rm -rf "$KIT_WORK/kit" && mkdir -p "$KIT_WORK/kit"
  tar xzf "$STRATA_TARBALL" -C "$KIT_WORK/kit" ./kit
  STRATA_KIT="$KIT_WORK/kit/kit/build-kit.sh"
fi
exec bash "$STRATA_KIT"
