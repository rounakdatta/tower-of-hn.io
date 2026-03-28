package tts

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"
)

// SynthesizeRequest is the request to generate speech from text.
type SynthesizeRequest struct {
	Text    string  `json:"text"`
	VoiceID string  `json:"voice_id"`
	Speed   float64 `json:"speed"`
	Format  string  `json:"format"`
}

// SynthesizeResponse contains the generated audio data.
type SynthesizeResponse struct {
	AudioData  []byte
	DurationMs int
	Format     string
}

// provider represents a single TTS service endpoint.
type provider struct {
	name    string
	baseURL string
	healthy bool
}

// Client communicates with TTS service(s), falling back through providers in order.
type Client struct {
	httpClient *http.Client
	providers  []provider
	logger     *slog.Logger
}

// NewClient creates a client with a primary TTS provider.
func NewClient(baseURL string) *Client {
	return &Client{
		httpClient: &http.Client{Timeout: 60 * time.Second},
		providers:  []provider{{name: "primary", baseURL: baseURL, healthy: true}},
		logger:     slog.Default(),
	}
}

// AddProvider adds a fallback TTS provider. Providers are tried in the order added.
func (c *Client) AddProvider(name, baseURL string) {
	c.providers = append(c.providers, provider{name: name, baseURL: baseURL, healthy: true})
}

// Synthesize tries each provider in order until one succeeds.
func (c *Client) Synthesize(ctx context.Context, req SynthesizeRequest) (*SynthesizeResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshaling request: %w", err)
	}

	var lastErr error
	for i := range c.providers {
		p := &c.providers[i]

		resp, err := c.callProvider(ctx, p, body)
		if err != nil {
			c.logger.Warn("TTS provider failed, trying next",
				"provider", p.name, "error", err)
			lastErr = err
			p.healthy = false
			continue
		}

		// Mark as healthy on success
		p.healthy = true
		return resp, nil
	}

	return nil, fmt.Errorf("all TTS providers failed, last error: %w", lastErr)
}

func (c *Client) callProvider(ctx context.Context, p *provider, body []byte) (*SynthesizeResponse, error) {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		p.baseURL+"/synthesize", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("creating request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("calling %s: %w", p.name, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		// Read error body for debugging
		errBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("%s returned status %d: %s", p.name, resp.StatusCode, string(errBody))
	}

	audioData, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading audio from %s: %w", p.name, err)
	}

	durationMs, _ := strconv.Atoi(resp.Header.Get("X-Duration-Ms"))

	return &SynthesizeResponse{
		AudioData:  audioData,
		DurationMs: durationMs,
		Format:     resp.Header.Get("Content-Type"),
	}, nil
}

// HealthCheck checks the first healthy provider.
func (c *Client) HealthCheck(ctx context.Context) error {
	for _, p := range c.providers {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.baseURL+"/health", nil)
		if err != nil {
			continue
		}
		resp, err := c.httpClient.Do(req)
		if err != nil {
			continue
		}
		resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			return nil
		}
	}
	return fmt.Errorf("no healthy TTS providers")
}
