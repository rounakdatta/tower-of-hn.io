package filestorage

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// Local implements store.BlobStore using the local filesystem.
type Local struct {
	basePath string
}

func NewLocal(basePath string) (*Local, error) {
	if err := os.MkdirAll(basePath, 0o755); err != nil {
		return nil, fmt.Errorf("creating base path %s: %w", basePath, err)
	}
	return &Local{basePath: basePath}, nil
}

func (l *Local) Write(_ context.Context, key string, data []byte) error {
	fullPath := filepath.Join(l.basePath, key)
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
		return fmt.Errorf("creating directories for %s: %w", key, err)
	}
	return os.WriteFile(fullPath, data, 0o644)
}

func (l *Local) Read(_ context.Context, key string) (io.ReadCloser, error) {
	fullPath := filepath.Join(l.basePath, key)
	return os.Open(fullPath)
}

func (l *Local) URL(_ context.Context, key string) (string, error) {
	return filepath.Join(l.basePath, key), nil
}

func (l *Local) Delete(_ context.Context, key string) error {
	fullPath := filepath.Join(l.basePath, key)
	return os.Remove(fullPath)
}
