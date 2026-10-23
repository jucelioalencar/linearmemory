FROM nginx:1.31.3-alpine3.24-slim
RUN apk upgrade --no-cache
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY search-filter.js /usr/share/nginx/html/search-filter.js
COPY index.html /usr/share/nginx/html/index.html
COPY ico.png /usr/share/nginx/html/ico.png
COPY vendor /usr/share/nginx/html/vendor
EXPOSE 8080
