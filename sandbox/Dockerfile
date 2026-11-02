FROM node:22-bookworm-slim
WORKDIR /runner
COPY --chown=node:node server.mjs ./server.mjs
RUN mkdir -p /run/brain-sandbox && chown node:node /run/brain-sandbox
USER node
CMD ["node","server.mjs"]
