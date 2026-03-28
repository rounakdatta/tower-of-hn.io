package config

import (
	"fmt"
	"os"
	"strconv"
)

type Config struct {
	// Server
	Port        int
	FrontendURL string

	// Database
	DatabaseURL string

	// TTS Service
	TTSServiceURL string

	// Audio Storage
	AudioStoragePath string

	// HN API
	HNAPIBaseURL string

	// Sentiment (Gemini Flash)
	GeminiAPIKey string

	// Worker
	HNSyncWorkers     int
	AudioPipelineWorkers int
}

func Load() (*Config, error) {
	port, _ := strconv.Atoi(getEnv("BACKEND_PORT", "8080"))
	hnSyncWorkers, _ := strconv.Atoi(getEnv("HN_SYNC_WORKERS", "20"))
	audioPipelineWorkers, _ := strconv.Atoi(getEnv("AUDIO_PIPELINE_WORKERS", "5"))

	cfg := &Config{
		Port:                 port,
		FrontendURL:          getEnv("FRONTEND_URL", "http://localhost:3000"),
		DatabaseURL:          getEnv("DATABASE_URL", "postgres://tower:tower_dev@localhost:5432/tower_hn?sslmode=disable"),
		TTSServiceURL:        getEnv("TTS_SERVICE_URL", "http://localhost:8000"),
		AudioStoragePath:     getEnv("AUDIO_STORAGE_PATH", "./data/audio"),
		HNAPIBaseURL:         getEnv("HN_API_BASE_URL", "https://hacker-news.firebaseio.com/v0"),
		GeminiAPIKey:         os.Getenv("GEMINI_API_KEY"),
		HNSyncWorkers:        hnSyncWorkers,
		AudioPipelineWorkers: audioPipelineWorkers,
	}

	if cfg.GeminiAPIKey == "" {
		return nil, fmt.Errorf("GEMINI_API_KEY is required")
	}

	return cfg, nil
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
