FROM node:20-bookworm-slim

WORKDIR /app

# install build deps in case better-sqlite3 falls through to source compile
# (it won't on node 20 — prebuild exists — but cheap insurance)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
 && rm -rf /var/lib/apt/lists/*

# install deps first so they cache when only source changes
COPY package.json package-lock.json ./
RUN npm ci --omit=dev=false

# copy source and build
COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "run", "start"]
