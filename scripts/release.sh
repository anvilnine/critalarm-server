#!/usr/bin/env bash
#
# Cut a production release.
#
#   ./scripts/release.sh               # patch, 0.1.0 -> 0.1.1
#   ./scripts/release.sh minor         # 0.1.0 -> 0.2.0
#   ./scripts/release.sh major         # 0.1.0 -> 1.0.0
#   ./scripts/release.sh patch --yes   # no confirmation prompt
#
# or through npm:
#
#   npm run release -- minor
#
# It bumps the version in package.json, commits, tags v<version>, and pushes
# main and the tag. The tag push is what deploys production, so every check
# runs before anything leaves this machine, and nothing is written to the repo
# until you confirm.
#
# It does NOT touch CHANGELOG.md. That file versions the API contract in
# docs/api.md, not this binary, and the orchestrator owns it. Do not wire a
# changelog bump in here.

set -euo pipefail

cd "$(dirname "$0")/.."

bump="patch"
assume_yes="no"

for arg in "$@"; do
  case "$arg" in
    patch|minor|major) bump="$arg" ;;
    --yes|-y) assume_yes="yes" ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: scripts/release.sh [patch|minor|major] [--yes]" >&2
      exit 1
      ;;
  esac
done

stop() {
  echo "Stopped: $1" >&2
  exit 1
}

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ]; then
  stop "you are on $branch. Releases are cut from main."
fi

if [ -n "$(git status --porcelain)" ]; then
  stop "the working tree has changes. Commit or stash them first."
fi

git fetch origin main --tags --quiet
if [ "$(git rev-parse main)" != "$(git rev-parse origin/main)" ]; then
  stop "main and origin/main point at different commits. Pull or push first."
fi

current="$(node -p "require('./package.json').version")"
next="$(node -e '
  const [major, minor, patch] = process.argv[1].split(".").map(Number);
  const bump = process.argv[2];
  if ([major, minor, patch].some(Number.isNaN)) {
    console.error(`package.json version "${process.argv[1]}" is not major.minor.patch.`);
    process.exit(1);
  }
  const next = bump === "major" ? [major + 1, 0, 0]
    : bump === "minor" ? [major, minor + 1, 0]
    : [major, minor, patch + 1];
  process.stdout.write(next.join("."));
' "$current" "$bump")"
tag="v$next"

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  stop "tag $tag already exists locally."
fi

if [ -n "$(git ls-remote --tags origin "refs/tags/$tag")" ]; then
  stop "tag $tag already exists on origin."
fi

echo "Running the checks before touching anything."
npm test
npm run typecheck

echo
echo "About to release:"
echo "  version   $current -> $next"
echo "  commit    bump package.json and package-lock.json"
echo "  tag       $tag, annotated"
echo "  push      main and $tag to origin"
echo
echo "Pushing $tag starts the production deploy."
echo

if [ "$assume_yes" != "yes" ]; then
  printf "Type the new version to confirm (%s): " "$next"
  read -r answer
  if [ "$answer" != "$next" ]; then
    stop "confirmation did not match."
  fi
fi

# --no-git-tag-version because the tag is created below, after the commit, so
# the commit message and the tag message stay under this script's control.
npm version "$next" --no-git-tag-version --allow-same-version >/dev/null

git add package.json package-lock.json
git commit -m "release $tag"
git tag -a "$tag" -m "critalarm-server $next"

git push origin main
git push origin "$tag"

echo
echo "Pushed $tag. The Release workflow builds the image and deploys production."
echo "Watch it at https://github.com/anvilnine/critalarm-server/actions"
