#!/bin/sh
# Postgres docker entrypoint hook: create the three ResourceHub roles and the database.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -f /resourcehub-sql/00-roles.sql
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname resourcehub -f /resourcehub-sql/01-database.sql
