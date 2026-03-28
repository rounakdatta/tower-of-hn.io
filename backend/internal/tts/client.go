package tts

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// Client communicates with the Python TTS microservice.
type Client struct {
	httpClient *http.Client
	baseURL    string
}

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

func NewClient(baseURL string) *Client {
	return &Client{
		httpClient: &http.Client{Timeout: 60 * time.Second},
		baseURL:    baseURL,
	}
}

func (c *Client) Synthesize(ctx context.Context, req SynthesizeRequest) (*SynthesizeResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshaling request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/synthesize", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("creating request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("calling TTS service: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("TTS service returned status %d", resp.StatusCode)
	}

	audioData, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading audio data: %w", err)
	}

	durationMs, _ := strconv.Atoi(resp.Header.Get("X-Duration-Ms"))

	return &SynthesizeResponse{
		AudioData:  audioData,
		DurationMs: durationMs,
		Format:     resp.Header.Get("Content-Type"),
	}, nil
}

func (c *Client) HealthCheck(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/health", nil)
	if err != nil {
		return err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("TTS service unhealthy: status %d", resp.StatusCode)
	}
	return nil
}
