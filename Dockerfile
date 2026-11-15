FROM node:24-alpine

WORKDIR /usr/src/app

# No dependencies: Node's built-in http and fetch are enough.
COPY package.json index.js translate.js ./

ENV NODE_ENV=production \
    PORT=8080 \
    PHOTON_URL=http://photon:2322

EXPOSE 8080
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
