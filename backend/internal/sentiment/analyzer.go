package sentiment

import (
	"context"

	"github.com/rounakdatta/tower-of-hn.io/backend/internal/domain"
)

// Analyzer classifies the sentiment of text.
type Analyzer interface {
	Analyze(ctx context.Context, text string) (*domain.Sentiment, error)
	AnalyzeBatch(ctx context.Context, texts []string) ([]*domain.Sentiment, error)
}
