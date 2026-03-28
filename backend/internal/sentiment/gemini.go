package sentiment

import (
	"context"
	"time"

	"github.com/rounakdatta/tower-of-hn.io/backend/internal/domain"
)

// GeminiAnalyzer uses Gemini Flash for sentiment classification.
type GeminiAnalyzer struct {
	apiKey string
	model  string
}

func NewGeminiAnalyzer(apiKey string) *GeminiAnalyzer {
	return &GeminiAnalyzer{
		apiKey: apiKey,
		model:  "gemini-2.0-flash",
	}
}

func (g *GeminiAnalyzer) Analyze(ctx context.Context, text string) (*domain.Sentiment, error) {
	// TODO: Implement Gemini Flash API call for sentiment classification
	// For now return neutral as a placeholder
	return &domain.Sentiment{
		Label:        domain.SentimentNeutral,
		Confidence:   0.5,
		Emotion:      "neutral",
		ModelVersion: g.model,
		AnalyzedAt:   time.Now(),
	}, nil
}

func (g *GeminiAnalyzer) AnalyzeBatch(ctx context.Context, texts []string) ([]*domain.Sentiment, error) {
	results := make([]*domain.Sentiment, len(texts))
	for i, text := range texts {
		s, err := g.Analyze(ctx, text)
		if err != nil {
			return nil, err
		}
		results[i] = s
	}
	return results, nil
}
