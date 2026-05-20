FROM node:20-alpine

# ffmpeg-static ships its own binary, but Alpine needs libc6-compat to run it
RUN apk add --no-cache libc6-compat python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

CMD ["npm", "start"]
