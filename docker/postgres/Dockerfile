FROM ghcr.io/evokoa/pggraph:1.2.0

ARG PG_MAJOR=17
ARG PGVECTOR_VERSION=0.8.6

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       build-essential \
       ca-certificates \
       git \
       postgresql-server-dev-${PG_MAJOR} \
    && git clone --branch "v${PGVECTOR_VERSION}" --depth 1 https://github.com/pgvector/pgvector.git /tmp/pgvector \
    && make -C /tmp/pgvector clean \
    && make -C /tmp/pgvector OPTFLAGS="" \
    && make -C /tmp/pgvector install \
    && rm -rf /tmp/pgvector \
    && apt-get purge -y --auto-remove build-essential git postgresql-server-dev-${PG_MAJOR} \
    && rm -rf /var/lib/apt/lists/*

COPY docker/postgres/init/10-linearmemory.sql /docker-entrypoint-initdb.d/10-linearmemory.sql
COPY docker/postgres/init/20-protocol-v2.sql /docker-entrypoint-initdb.d/20-protocol-v2.sql
