FROM node:20-alpine

RUN apk add --no-cache openssl

EXPOSE 3000
WORKDIR /app

COPY package.json package-lock.json* ./
# package.json's postinstall runs `prisma generate` (against the SQLite dev
# schema) as part of `npm ci` below — copy prisma/ ahead of the rest of the
# source so that hook has a schema file to find, instead of failing npm ci
# outright.
COPY prisma ./prisma

# NODE_ENV is NOT set yet here — npm treats that env var as an implicit
# --omit=dev regardless of the install flags used, and the build step below
# (`remix vite:build`) needs @remix-run/dev and vite, both devDependencies.
# It's set further down, right before CMD, so it only affects the running
# app, not this install/build.
RUN npm ci

COPY . .

# Regenerate the Prisma Client against the Postgres schema — overwrites the
# SQLite client the postinstall hook produced above, and belt-and-suspenders
# against a host serving a cached image/layer without re-running CMD's own
# generate step (docker-start's setup:production).
RUN npx prisma generate --schema prisma/schema.production.prisma

RUN npm run build

ENV NODE_ENV=production

CMD ["npm", "run", "docker-start"]
