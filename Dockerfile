FROM node:22-alpine AS build

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.js ./
COPY src ./src
COPY server ./server
COPY .env.example ./.env.example

RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime

RUN addgroup -S app -g 10001 \
  && adduser -S -D -H -u 10001 -G app app

WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY .env.example ./.env.example

RUN mkdir -p /app/data && chown -R app:app /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=38471
ENV SQLITE_DB_PATH=/app/data/app.db

USER app

EXPOSE 38471

CMD ["node", "server/index.js"]
