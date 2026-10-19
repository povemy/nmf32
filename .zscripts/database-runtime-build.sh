#!/bin/bash
# Supabase (PostgreSQL) runtime-build step — post SQLite→Supabase migration.
# The database lives in the cloud (Supabase Postgres via Prisma, see
# prisma/schema.prisma); there is NO local SQLite file to carry into build
# output anymore. This step only syncs the Prisma schema to the cloud DB.

set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/home/z/my-project}"

echo "🗄️  Supabase Postgres — syncing Prisma schema to the cloud database (no local DB file since the SQLite→Supabase migration)..."
(
    cd "$PROJECT_DIR"
    bun run db:push
)

echo "✅ 构建产物数据库已准备完成（远程 Supabase Postgres）"
