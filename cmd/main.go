package main

import (
	"context"
	"log/slog"
	"sync"

	"github.com/hibiken/asynq"
	"github.com/rounakdatta/tower-of-hn.io/config"
	"github.com/rounakdatta/tower-of-hn.io/internal/db"
	"github.com/rounakdatta/tower-of-hn.io/internal/handler"
)

var logger *slog.Logger

func init() {
	logger = slog.Default()
}

func startWorkerJob(ctx context.Context, wg *sync.WaitGroup, taskQueue *asynq.Client) {
	defer wg.Done()

	srv := asynq.NewServer(
		asynq.RedisClientOpt{
			Addr: "localhost:6379",
		},
		asynq.Config{
			Concurrency: 10,
		},
	)

	mux := asynq.NewServeMux()
	mux.HandleFunc(handler.TaskTypeNoOp, handler.HandleNoOp)

	// start the server so that it can start processing tasks
	if err := srv.Run(mux); err != nil {
		logger.Error("Failed to start server", "error", err)
		return
	}

	// gracefully shutdown the worker server on context cancellation
	<-ctx.Done()
	logger.Info("Received event for shutting down")
	srv.Shutdown()
}

func main() {
	config, err := config.LoadConfigurationFromEnvironmentVariables(logger)
	if err != nil {
		logger.Error("Failed to load configuration from environment variables", "error", err)
	}

	pool, err := db.NewPool(config.DatabaseHost, config.DatabasePort, config.DatabaseUsername, config.DatabasePassword, config.DatabaseName, logger)
	if err != nil {
		logger.Error("Failed to create database connection pool", "error", err)
	}
	defer pool.Close()
}
