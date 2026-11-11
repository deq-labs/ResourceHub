# Build context: packages/integrations
FROM node:22-alpine
WORKDIR /app
COPY mocks/soap-server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY mocks/soap-server/server.mjs ./
COPY wsdl/partner-docs.wsdl ./partner-docs.wsdl
USER node
EXPOSE 8088
HEALTHCHECK --interval=5s --timeout=3s --retries=10 CMD wget -qO- http://127.0.0.1:8088/health || exit 1
CMD ["node", "server.mjs"]
