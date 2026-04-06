#!/bin/sh
# Start x-dashboard in background (internal, reads from /data)
cd /app/dashboard && bun lib/x-dashboard-server.mjs --port 19841 --scan /data &

# Wait for dashboard to be ready
sleep 1

# Start x-sync server in foreground (proxies to dashboard)
cd /app/sync && exec bun x-sync-server.mjs
