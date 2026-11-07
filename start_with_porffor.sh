#!/bin/sh

# This is demonstration, and test, how would this work with PostgreSQL and
# porffor. 
# 
# Prerequisites podman and porffor (https://porffor.dev/)

set -e
trap 'podman stop pg-throwaway' EXIT

podman run --replace --rm -d --name pg-throwaway -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:5432:5432 docker.io/library/postgres:18-alpine

pnpm --filter backend run build:pg

echo "Waiting 5 seconds for PostgreSQL to be ready..."

sleep 5

porf packages/backend/dist.pg/main.pg.js --schema --seed --database-url postgres://postgres@127.0.0.1:5432/postgres

