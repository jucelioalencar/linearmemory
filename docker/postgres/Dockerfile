FROM ghcr.io/evokoa/pggraph:1.2.0 AS pggraph

FROM postgres:17-trixie

ARG PG_MAJOR=17
ARG PGVECTOR_VERSION=0.8.6

RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       postgresql-${PG_MAJOR}-cron \
       postgresql-${PG_MAJOR}-pgvector=${PGVECTOR_VERSION}-1.pgdg13+1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=pggraph /usr/lib/postgresql/17/lib/graph.so /usr/lib/postgresql/17/lib/graph.so
COPY --from=pggraph /usr/share/postgresql/17/extension/graph* /usr/share/postgresql/17/extension/
COPY --from=pggraph /docker-entrypoint-initdb.d/01-create-extensions-and-schedule.sql /docker-entrypoint-initdb.d/01-create-extensions-and-schedule.sql

COPY docker/postgres/init/10-linearmemory.sql /docker-entrypoint-initdb.d/10-linearmemory.sql
COPY docker/postgres/init/20-protocol-v2.sql /docker-entrypoint-initdb.d/20-protocol-v2.sql
