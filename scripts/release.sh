#!/usr/bin/env bash
# 本機發版：檢查、驗證後建立 GitHub Release，由 npm-publish.yml 接手發布到 npm。
# 用法：npm run release -- <patch|minor|major|x.y.z> [--dry-run]
set -euo pipefail

usage() {
  echo "用法：npm run release -- <patch|minor|major|x.y.z> [--dry-run]" >&2
  exit 1
}

die() {
  echo "❌ $*" >&2
  exit 1
}

bump=""
dry_run=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    patch | minor | major) bump="$arg" ;;
    *)
      if [[ "$arg" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then bump="$arg"; else usage; fi
      ;;
  esac
done
[[ -n "$bump" ]] || usage

cd "$(git rev-parse --show-toplevel)"

# 1. 只能在 main 發版
branch="$(git rev-parse --abbrev-ref HEAD)"
[[ "$branch" == "main" ]] || die "只能在 main 發版（目前在 ${branch}）"

# 2. 工作區乾淨
[[ -z "$(git status --porcelain)" ]] || die "工作區有未提交的修改，請先處理"

# 3. 與 origin/main 同步
git fetch origin main --tags --quiet
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] \
  || die "本地 main 與 origin/main 不同步，請先 pull 或 push"

# 4. gh 可用
command -v gh > /dev/null || die "找不到 gh，請先安裝 GitHub CLI"
gh auth status > /dev/null 2>&1 || die "gh 尚未登入，請先執行 gh auth login"

# 5. 計算新版本（從最新的 vX.Y.Z tag 起算；還沒有任何 tag 時從 0.0.0 起算，首發請直接指定 x.y.z）
latest_tag="$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || true)"
if [[ -n "$latest_tag" ]]; then
  current="${latest_tag#v}"
else
  latest_tag="(無 tag)"
  current="0.0.0"
  echo "ℹ️  還沒有任何 vX.Y.Z tag，視為首次發版"
fi
IFS=. read -r major minor patch <<< "$current"

case "$bump" in
  major) next="$((major + 1)).0.0" ;;
  minor) next="$major.$((minor + 1)).0" ;;
  patch) next="$major.$minor.$((patch + 1))" ;;
  *)
    next="$bump"
    highest="$(printf '%s\n%s\n' "$current" "$next" | sort -V | tail -1)"
    [[ "$highest" == "$next" && "$next" != "$current" ]] \
      || die "指定的版本 $next 必須大於目前最新版 $current"
    ;;
esac
next_tag="v$next"

# 6. 新 tag 不能已存在（本地與遠端）
git rev-parse -q --verify "refs/tags/$next_tag" > /dev/null && die "tag $next_tag 已存在於本地"
[[ -z "$(git ls-remote --tags origin "refs/tags/$next_tag")" ]] || die "tag $next_tag 已存在於遠端"

# 7. 本機驗證（CI 發布時也會跑，先擋下可省一輪失敗的 Release）
echo "▶ $latest_tag → ${next_tag}，先跑驗證"
# 驗證輸出先存進暫存檔，通過就不顯示，失敗才印出來
verify_log="$(mktemp)"
trap 'rm -f "$verify_log"' EXIT
for step in typecheck test build; do
  if [[ "$step" == test ]]; then cmd=(npm test); else cmd=(npm run "$step"); fi
  if "${cmd[@]}" > "$verify_log" 2>&1; then
    echo "  ✓ $step"
  else
    cat "$verify_log" >&2
    die "$step 失敗，未建立 Release"
  fi
done

# 8. 確認
echo

if [[ "$dry_run" == 1 ]]; then
  echo "✅ dry-run 完成：檢查與驗證都通過，將把 package.json 更新為 $next 並建立 ${next_tag}（未實際變更）"
  exit 0
fi

read -r -p "確定要發布 $next_tag 嗎？(y/N) " answer
[[ "$answer" == [yY] ]] || die "已取消"

# 9. 更新 package.json 的 version 並 commit、push（版本已相同時，例如首發，不需要 commit）
npm pkg set version="$next"
if ! git diff --quiet package.json; then
  git add package.json
  git commit -m "$next"
  git push origin main
fi

# 10. 建立 Release，npm-publish.yml 會接手發布
gh release create "$next_tag" --target main --generate-notes --title "$next_tag"

echo
echo "✅ 已建立 Release $next_tag"
echo "   npm 發布進度：$(gh repo view --json url --jq .url)/actions/workflows/npm-publish.yml"
