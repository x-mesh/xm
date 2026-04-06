FROM oven/bun:1-alpine
WORKDIR /app

# x-sync server
COPY x-sync/lib/x-sync-server.mjs ./sync/

# x-dashboard (static files + server)
COPY x-dashboard/lib/x-dashboard-server.mjs ./dashboard/lib/
COPY x-dashboard/public/ ./dashboard/public/

# Entrypoint
COPY x-sync/entrypoint.sh .
RUN chmod +x entrypoint.sh

EXPOSE 19842
CMD ["sh", "entrypoint.sh"]
