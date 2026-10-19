#!/bin/bash
# Runtime-build test for the Supabase (PostgreSQL) era.
# Asserts that the deploy helper:
#   1. runs `bun run db:push` exactly once per invocation (schema sync to Supabase),
#   2. does NOT create or copy any local SQLite database (db/custom.db) — SQLite
#      was eradicated in the SQLite→Supabase migration.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../.zscripts" && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

FAKE_BIN="$TEST_ROOT/bin"
mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/bun" <<'EOF'
#!/bin/bash
set -euo pipefail

if [ "$#" -ne 2 ] || [ "$1" != "run" ] || [ "$2" != "db:push" ]; then
    echo "unexpected bun invocation: $*" >&2
    exit 1
fi

printf 'db:push\n' >>"${DB_PUSH_CALLS:?}"
EOF
chmod +x "$FAKE_BIN/bun"

export PATH="$FAKE_BIN:$PATH"
export DB_PUSH_CALLS="$TEST_ROOT/db-push-calls"

# 无本地数据库时应只同步云端 schema，不在部署产物中生成任何 SQLite 文件。
EMPTY_PROJECT="$TEST_ROOT/empty-project"
EMPTY_BUILD="$TEST_ROOT/empty-build"
mkdir -p "$EMPTY_PROJECT"

PROJECT_DIR="$EMPTY_PROJECT" BUILD_DIR="$EMPTY_BUILD" \
    bash "$SCRIPT_DIR/database-runtime-build.sh"

test "$(wc -l <"$DB_PUSH_CALLS" | tr -d ' ')" = "1"
test ! -e "$EMPTY_BUILD/db"
test ! -e "$EMPTY_PROJECT/db"

# 遗留 SQLite 文件必须保持原样且绝不复制进构建产物。
EXISTING_PROJECT="$TEST_ROOT/existing-project"
EXISTING_BUILD="$TEST_ROOT/existing-build"
mkdir -p "$EXISTING_PROJECT/db"
printf 'legacy-sqlite\n' >"$EXISTING_PROJECT/db/custom.db"

PROJECT_DIR="$EXISTING_PROJECT" BUILD_DIR="$EXISTING_BUILD" \
    bash "$SCRIPT_DIR/database-runtime-build.sh"

test "$(wc -l <"$DB_PUSH_CALLS" | tr -d ' ')" = "2"
test ! -e "$EXISTING_BUILD/db"
test "$(cat "$EXISTING_PROJECT/db/custom.db")" = "legacy-sqlite"   # untouched, not copied

echo "database runtime build tests passed"
