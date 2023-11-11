package db

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v4/pgxpool"
)

func NewPool(databaseHost string, databasePort int, databaseUser, databasePassword, databaseName string, logger *slog.Logger) (*pgxpool.Pool, error) {
	logger.Info("Connecting to database", "database endpoint", fmt.Sprintf("%s:%d", databaseHost, databasePort))
	connectionString := fmt.Sprintf("postgres://%s:%d@%s:%s/%s", databaseHost, databasePort, databaseUser, databasePassword, databaseName)
	return pgxpool.Connect(context.Background(), connectionString)
}
