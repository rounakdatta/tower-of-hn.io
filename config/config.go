package config

import (
	"log/slog"
	"os"
	"strconv"
)

type Config struct {
	DatabaseHost     string
	DatabasePort     int
	DatabaseUsername string
	DatabasePassword string
	DatabaseName     string
}

func LoadConfigurationFromEnvironmentVariables(logger *slog.Logger) (*Config, error) {
	dbPort, err := strconv.Atoi("DB_PORT")
	if err != nil {
		logger.Info("DB_PORT not set, using default port 5432")
		dbPort = 5432
	}

	return &Config{
		DatabaseHost:     os.Getenv("DB_HOST"),
		DatabasePort:     dbPort,
		DatabaseUsername: os.Getenv("DB_USERNAME"),
		DatabasePassword: os.Getenv("DB_PASSWORD"),
		DatabaseName:     os.Getenv("DB_NAME"),
	}, nil
}
