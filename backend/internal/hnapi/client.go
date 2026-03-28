package hnapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

type Client struct {
	httpClient *http.Client
	baseURL    string
}

func NewClient(baseURL string) *Client {
	return &Client{
		httpClient: &http.Client{Timeout: 10 * time.Second},
		baseURL:    baseURL,
	}
}

func (c *Client) GetItem(ctx context.Context, id int64) (*Item, error) {
	url := fmt.Sprintf("%s/item/%d.json", c.baseURL, id)
	item, err := doGet[Item](ctx, c.httpClient, url)
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (c *Client) GetTopStories(ctx context.Context) ([]int64, error) {
	url := fmt.Sprintf("%s/topstories.json", c.baseURL)
	return doGet[[]int64](ctx, c.httpClient, url)
}

func doGet[T any](ctx context.Context, client *http.Client, url string) (T, error) {
	var zero T

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return zero, fmt.Errorf("creating request: %w", err)
	}

	resp, err := client.Do(req)
	if err != nil {
		return zero, fmt.Errorf("executing request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return zero, fmt.Errorf("unexpected status %d for %s", resp.StatusCode, url)
	}

	var result T
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return zero, fmt.Errorf("decoding response: %w", err)
	}
	return result, nil
}
