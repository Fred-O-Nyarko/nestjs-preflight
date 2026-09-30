FROM node:20
WORKDIR /app
ENV STRIPE_SECRET_KEY=changeme
COPY . .
RUN npm install
RUN npm run build
CMD npm run start:prod
