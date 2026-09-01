FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
USER node
EXPOSE 3333
CMD ["sh", "-c", "cp /run/secrets/postgres-pgpass /tmp/postgres-pgpass && chmod 600 /tmp/postgres-pgpass && export PGPASSFILE=/tmp/postgres-pgpass && exec npm start"]
