#!/usr/bin/env bash
set -euo pipefail

echo "Starting Tower of HN development environment..."

# Start PostgreSQL via Docker
echo "Starting PostgreSQL..."
docker compose up -d postgres
sleep 3

# Run migrations
echo "Running migrations..."
make migrate

# Start services in background
echo "Starting TTS service..."
cd tts-service && uvicorn app.main:app --reload --port 8000 &
TTS_PID=$!

echo "Starting Go backend..."
cd ../backend && go run ./cmd/server &
BACKEND_PID=$!

echo "Starting Next.js frontend..."
cd ../frontend && npm run dev &
FRONTEND_PID=$!

echo ""
echo "All services started:"
echo "  Frontend:    http://localhost:3000"
echo "  Backend:     http://localhost:8080"
echo "  TTS Service: http://localhost:8000"
echo ""
echo "Press Ctrl+C to stop all services"

trap "kill $TTS_PID $BACKEND_PID $FRONTEND_PID 2>/dev/null; docker compose stop postgres" EXIT

wait
