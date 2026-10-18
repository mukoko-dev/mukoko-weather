#!/usr/bin/env bash
# Next release version under the Mukoko rollover policy (owner: Bryan).
#
#   next-version.sh BASE BUMP [VERSION]
#
#   BASE     latest stable tag, vX.Y.Z (empty means v0.0.0)
#   BUMP     patch | minor | major (ignored when VERSION is given)
#   VERSION  optional exact vX.Y.Z; validated, overrides BUMP
#
# Policy: strict vMAJOR.MINOR.PATCH, no suffixes. PATCH runs 0-99 and then
# rolls over to the next MINOR with PATCH reset to 0. MINOR runs 0-999.
# A MAJOR is only ever made by hand (bump=major or an explicit VERSION);
# a rollover that would push MINOR past 999 fails and asks for one.
#
# Prints the tag on stdout. On refusal prints a GitHub ::error:: line on
# stderr and exits 1.
set -euo pipefail

MAX_PATCH=99
MAX_MINOR=999
SEMVER='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

fail() {
  echo "::error::$1" >&2
  exit 1
}

BASE="${1:-}"
BUMP="${2:-patch}"
INPUT_VERSION="${3:-}"
BASE="${BASE:-v0.0.0}"

[[ "$BASE" =~ $SEMVER ]] || fail "latest tag must match vX.Y.Z, got '$BASE'."
MAJOR=$((10#${BASH_REMATCH[1]}))
MINOR=$((10#${BASH_REMATCH[2]}))
PATCH=$((10#${BASH_REMATCH[3]}))

if [ -n "$INPUT_VERSION" ]; then
  [[ "$INPUT_VERSION" =~ $SEMVER ]] || fail "version must match vX.Y.Z (no suffixes), got '$INPUT_VERSION'."
  N_MAJOR=$((10#${BASH_REMATCH[1]}))
  N_MINOR=$((10#${BASH_REMATCH[2]}))
  N_PATCH=$((10#${BASH_REMATCH[3]}))
  if [ "$N_PATCH" -gt "$MAX_PATCH" ]; then
    fail "PATCH must be 0-$MAX_PATCH, got $N_PATCH in $INPUT_VERSION. Roll over to the next minor instead."
  fi
  if [ "$N_MINOR" -gt "$MAX_MINOR" ]; then
    fail "MINOR must be 0-$MAX_MINOR, got $N_MINOR in $INPUT_VERSION."
  fi
  GREATER=0
  if [ "$N_MAJOR" -ne "$MAJOR" ]; then
    [ "$N_MAJOR" -gt "$MAJOR" ] && GREATER=1
  elif [ "$N_MINOR" -ne "$MINOR" ]; then
    [ "$N_MINOR" -gt "$MINOR" ] && GREATER=1
  elif [ "$N_PATCH" -gt "$PATCH" ]; then
    GREATER=1
  fi
  [ "$GREATER" -eq 1 ] || fail "$INPUT_VERSION must be greater than the latest tag $BASE."
  echo "$INPUT_VERSION"
  exit 0
fi

case "$BUMP" in
  major)
    echo "v$((MAJOR + 1)).0.0"
    ;;
  minor)
    if [ "$MINOR" -ge "$MAX_MINOR" ]; then
      fail "$BASE is at MINOR $MAX_MINOR; a minor bump needs a manual major bump (rerun with bump=major or version=v$((MAJOR + 1)).0.0). Only Bryan triggers a major."
    fi
    echo "v$MAJOR.$((MINOR + 1)).0"
    ;;
  patch)
    if [ "$PATCH" -ge "$MAX_PATCH" ]; then
      if [ "$MINOR" -ge "$MAX_MINOR" ]; then
        fail "$BASE is at MINOR $MAX_MINOR and PATCH $MAX_PATCH; the rollover needs a manual major bump (rerun with bump=major or version=v$((MAJOR + 1)).0.0). Only Bryan triggers a major."
      fi
      echo "v$MAJOR.$((MINOR + 1)).0"
    else
      echo "v$MAJOR.$MINOR.$((PATCH + 1))"
    fi
    ;;
  *)
    fail "bump must be patch, minor or major, got '$BUMP'."
    ;;
esac
