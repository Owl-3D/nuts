FROM node:22-alpine

# Switch to /app
WORKDIR /app
# Install deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Copy source
COPY . ./

# Ports
ENV PORT 80
EXPOSE 80

ENTRYPOINT ["npm", "start"]
