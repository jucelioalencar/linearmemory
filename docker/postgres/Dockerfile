FROM ghcr.io/evokoa/pggraph:1.2.0 AS pggraph

FROM golang:1.26.6-trixie AS gosu-builder

ARG GOSU_COMMIT=6456aaa0f3c854d199d0f037f068eb97515b7513

ENV CGO_ENABLED=0

RUN git init /src/gosu \
    && git -C /src/gosu fetch --depth 1 https://github.com/tianon/gosu.git "${GOSU_COMMIT}:" \
    && git -C /src/gosu checkout --detach FETCH_HEAD

WORKDIR /src/gosu

RUN go build \
    -trimpath \
    -buildvcs=false \
    -ldflags='-d -s -w' \
    -o /out/gosu .

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
COPY --from=gosu-builder /out/gosu /usr/local/bin/gosu

COPY docker/postgres/init/10-linearmemory.sql /docker-entrypoint-initdb.d/10-linearmemory.sql
COPY docker/postgres/init/20-protocol-v2.sql /docker-entrypoint-initdb.d/20-protocol-v2.sql
