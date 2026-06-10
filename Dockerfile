# Hardened Alpine on the current Node LTS. Alpine keeps a shell for debugging;
# `apk upgrade` patches OS packages, `npm ci --omit=dev` is reproducible, and the
# app runs as the unprivileged `node` user.
FROM node:24-alpine

# Patch any OS packages with newer security fixes than the base image shipped with.
RUN apk upgrade --no-cache

WORKDIR /usr/src/app

# Install dependencies from the lockfile only (no dev deps, reproducible).
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the application code (see .dockerignore for what is excluded).
COPY . .

# Ember+ provider port (override the listen port with EMBER_PORT).
EXPOSE 9000

# Default vMix connection (override at runtime).
ENV VMIX_HOST=localhost
ENV VMIX_PORT=8099

# Drop privileges: run as the built-in unprivileged user.
USER node

CMD ["node", "bridge.js"]
