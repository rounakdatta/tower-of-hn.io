package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/rounakdatta/tower-of-hn.io/backend/internal/config"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/hnapi"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/server"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/store/filestorage"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/store/postgres"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/worker"
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

	// Blob storage
	blobStore, err := filestorage.NewLocal(cfg.AudioStoragePath)
	if err != nil {
		logger.Error("Failed to initialize blob storage", "error", err)
		os.Exit(1)
	}

	// Store implementations
	storyStore := postgres.NewStoryStore(db)
	commentStore := postgres.NewCommentStore(db)
	threadStore := postgres.NewThreadStore(db)
	audioStore := postgres.NewAudioStore(db)
	sentimentStore := postgres.NewSentimentStore(db)
	voiceStore := postgres.NewVoiceStore(db)
	avatarStore := postgres.NewAvatarStore(db)

	// HTTP server
	srv := server.New(cfg.Port, server.Dependencies{
		Stories:   storyStore,
		Threads:   threadStore,
		Comments:  commentStore,
		Audio:     audioStore,
		Blobs:     blobStore,
		Sentiment: sentimentStore,
		Voices:    voiceStore,
		Avatars:   avatarStore,
	}, logger)

	// HN API clients
	hnClient := hnapi.NewClient(cfg.HNAPIBaseURL)
	hnFetcher := hnapi.NewFetcher(hnClient, cfg.HNSyncWorkers)
	hnStreamer := hnapi.NewStreamer(cfg.HNAPIBaseURL, logger)

	// HN Syncer
	syncer := worker.NewHNSyncer(
		hnClient,
		hnFetcher,
		hnStreamer,
		storyStore,
		commentStore,
		threadStore,
		srv.Hub(),
		logger,
	)

	// Start HN syncer in background
	go func() {
		if err := syncer.Run(ctx); err != nil && ctx.Err() == nil {
			logger.Error("HN syncer error", "error", err)
		}
	}()

	// Start HTTP server
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
