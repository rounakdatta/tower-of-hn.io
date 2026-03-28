package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/rounakdatta/tower-of-hn.io/backend/internal/config"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/server"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/store/filestorage"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/store/postgres"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	cfg, err := config.Load()
	if err != nil {
		logger.Error("Failed to load config", "error", err)
		os.Exit(1)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	// Database
	db, err := postgres.New(ctx, cfg.DatabaseURL, logger)
	if err != nil {
		logger.Error("Failed to connect to database", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	// Blob storage (local filesystem)
	blobStore, err := filestorage.NewLocal(cfg.AudioStoragePath)
	if err != nil {
		logger.Error("Failed to initialize blob storage", "error", err)
		os.Exit(1)
	}

	// Server with all store implementations
	srv := server.New(cfg.Port, server.Dependencies{
		Stories:   postgres.NewStoryStore(db),
		Threads:   postgres.NewThreadStore(db),
		Comments:  postgres.NewCommentStore(db),
		Audio:     postgres.NewAudioStore(db),
		Blobs:     blobStore,
		Sentiment: postgres.NewSentimentStore(db),
		Voices:    postgres.NewVoiceStore(db),
		Avatars:   postgres.NewAvatarStore(db),
	}, logger)

	// Start server in goroutine
	go func() {
		if err := srv.Start(); err != nil {
			logger.Error("Server error", "error", err)
			cancel()
		}
	}()

	logger.Info("Tower of HN backend started", "port", cfg.Port)

	// Wait for shutdown signal
	<-ctx.Done()
	logger.Info("Shutting down...")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("Shutdown error", "error", err)
	}

	logger.Info("Goodbye")
}
