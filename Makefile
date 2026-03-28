.PHONY: dev dev-backend dev-frontend dev-tts build migrate migrate-down docker-up docker-down

# Development
dev: docker-up dev-backend dev-frontend

dev-backend:
	cd backend && go run ./cmd/server

dev-frontend:
	cd frontend && npm run dev

dev-tts:
	cd tts-service && uvicorn app.main:app --reload --port 8000

# Build
build:
	cd backend && go build -o bin/server ./cmd/server
	cd frontend && npm run build

# Database
migrate:
	@echo "Running migrations..."
	PGPASSWORD=tower_dev psql -h localhost -U tower -d tower_hn -f backend/internal/store/postgres/migrations/001_initial.up.sql

migrate-down:
	@echo "Rolling back migrations..."
	PGPASSWORD=tower_dev psql -h localhost -U tower -d tower_hn -f backend/internal/store/postgres/migrations/001_initial.down.sql

# Docker
docker-up:
	docker compose up -d postgres
	@echo "Waiting for PostgreSQL..."
	@sleep 3
	$(MAKE) migrate

docker-down:
	docker compose down

docker-all:
	docker compose up --build
