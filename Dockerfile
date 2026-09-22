FROM node:22-alpine
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
# npm install, not npm ci: this project ships bun.lock and no package-lock.json.
RUN npm install
RUN npm run build
ENV NODE_ENV=production HOSTNAME=0.0.0.0
EXPOSE 3001
CMD ["npm", "start"]
