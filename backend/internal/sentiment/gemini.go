package sentiment

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/rounakdatta/tower-of-hn.io/backend/internal/domain"
)

const (
	geminiBaseURL  = "https://generativelanguage.googleapis.com/v1beta/models"
	sentimentPrompt = `Classify the sentiment of this Hacker News comment as exactly one of these values: happy, sad, angry, surprised, confused, neutral, sarcastic, excited, thinking, worried.

Consider the tone carefully:
- Technical disagreements are often "thinking" not "angry"
- Sarcasm and dry wit are common on HN — detect "sarcastic"
- Sharing a personal project enthusiastically is "excited"
- Genuine questions are "confused" or "thinking"
- Complaints about industry trends are "worried" or "angry"

Return ONLY a JSON object, no markdown, no explanation:
{"sentiment": "one_of_the_values", "confidence": 0.0_to_1.0}

Comment: `
)

// GeminiAnalyzer uses Gemini Flash for sentiment classification.
type GeminiAnalyzer struct {
	apiKey     string
	model      string
	httpClient *http.Client
	logger     *slog.Logger
}

func NewGeminiAnalyzer(apiKey string) *GeminiAnalyzer {
	return &GeminiAnalyzer{
		apiKey:     apiKey,
		model:      "gemini-2.5-flash-lite",
		httpClient: &http.Client{Timeout: 15 * time.Second},
		logger:     slog.Default(),
	}
}

func (g *GeminiAnalyzer) Analyze(ctx context.Context, text string) (*domain.Sentiment, error) {
	if g.apiKey == "" || g.apiKey == "test-placeholder" {
		// No API key — return neutral silently
		return &domain.Sentiment{
			Label:        domain.SentimentNeutral,
			Confidence:   0.5,
			Emotion:      "neutral",
			ModelVersion: "none",
			AnalyzedAt:   time.Now(),
		}, nil
	}

	// Truncate very long comments for the LLM
	input := text
	if len(input) > 1000 {
		input = input[:1000] + "..."
	}

	// Build Gemini API request
	reqBody := map[string]interface{}{
		"contents": []map[string]interface{}{
			{
				"parts": []map[string]string{
					{"text": sentimentPrompt + input},
				},
			},
		},
		"generationConfig": map[string]interface{}{
			"temperature":     0.1,
			"maxOutputTokens": 50,
		},
	}

	bodyJSON, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("marshaling request: %w", err)
	}

	url := fmt.Sprintf("%s/%s:generateContent?key=%s", geminiBaseURL, g.model, g.apiKey)

	// Retry with backoff for rate limits
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			// Exponential backoff: 5s, 15s
			delay := time.Duration(5*(1<<attempt)) * time.Second
			g.logger.Info("Gemini rate limited, waiting", "delay", delay, "attempt", attempt+1)
			time.Sleep(delay)
		}

		result, err := g.callAPI(ctx, url, bodyJSON)
		if err != nil {
			if strings.Contains(err.Error(), "429") || strings.Contains(err.Error(), "RESOURCE_EXHAUSTED") {
				lastErr = err
				continue
			}
			return nil, err
		}
		return result, nil
	}

	// If all retries fail due to rate limits, return neutral rather than erroring
	g.logger.Warn("Gemini rate limited after retries, defaulting to neutral", "error", lastErr)
	return &domain.Sentiment{
		Label:        domain.SentimentNeutral,
		Confidence:   0.3,
		Emotion:      "neutral",
		ModelVersion: g.model + "-fallback",
		AnalyzedAt:   time.Now(),
	}, nil
}

func (g *GeminiAnalyzer) callAPI(ctx context.Context, url string, body []byte) (*domain.Sentiment, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := g.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("calling Gemini: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Gemini returned %d: %s", resp.StatusCode, string(respBody))
	}

	// Parse Gemini response
	var geminiResp struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}

	if err := json.Unmarshal(respBody, &geminiResp); err != nil {
		return nil, fmt.Errorf("parsing Gemini response: %w", err)
	}

	if len(geminiResp.Candidates) == 0 || len(geminiResp.Candidates[0].Content.Parts) == 0 {
		return nil, fmt.Errorf("empty Gemini response")
	}

	text := strings.TrimSpace(geminiResp.Candidates[0].Content.Parts[0].Text)

	// Strip markdown code fences if present
	text = strings.TrimPrefix(text, "```json")
	text = strings.TrimPrefix(text, "```")
	text = strings.TrimSuffix(text, "```")
	text = strings.TrimSpace(text)

	// Parse the JSON sentiment result
	var result struct {
		Sentiment  string  `json:"sentiment"`
		Confidence float64 `json:"confidence"`
	}

	if err := json.Unmarshal([]byte(text), &result); err != nil {
		g.logger.Warn("Failed to parse Gemini sentiment JSON, defaulting to neutral",
			"raw", text, "error", err)
		return &domain.Sentiment{
			Label:        domain.SentimentNeutral,
			Confidence:   0.3,
			Emotion:      "neutral",
			ModelVersion: g.model,
			AnalyzedAt:   time.Now(),
		}, nil
	}

	// Validate the sentiment label
	validLabels := map[string]bool{
		"happy": true, "sad": true, "angry": true, "surprised": true,
		"confused": true, "neutral": true, "sarcastic": true, "excited": true,
		"thinking": true, "worried": true,
	}
	if !validLabels[result.Sentiment] {
		result.Sentiment = "neutral"
		result.Confidence = 0.3
	}

	return &domain.Sentiment{
		Label:        result.Sentiment,
		Confidence:   result.Confidence,
		Emotion:      result.Sentiment,
		ModelVersion: g.model,
		AnalyzedAt:   time.Now(),
	}, nil
}

func (g *GeminiAnalyzer) AnalyzeBatch(ctx context.Context, texts []string) ([]*domain.Sentiment, error) {
	results := make([]*domain.Sentiment, len(texts))
	for i, text := range texts {
		s, err := g.Analyze(ctx, text)
		if err != nil {
			// Don't fail the whole batch — return neutral for failed ones
			results[i] = &domain.Sentiment{
				Label:        domain.SentimentNeutral,
				Confidence:   0.3,
				Emotion:      "neutral",
				ModelVersion: g.model,
				AnalyzedAt:   time.Now(),
			}
			continue
		}
		results[i] = s
	}
	return results, nil
}
