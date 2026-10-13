FROM node:22-alpine

RUN apk add --no-cache git

WORKDIR /app
COPY server.mjs sync.mjs relay.mjs ./

ENV WORKDIR=/work PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
