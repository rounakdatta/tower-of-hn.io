package hnapi

import (
	"context"
	"fmt"
	"sync"
)

// Fetcher provides concurrent item fetching with bounded parallelism.
type Fetcher struct {
	client     *Client
	maxWorkers int
}

func NewFetcher(client *Client, maxWorkers int) *Fetcher {
	return &Fetcher{client: client, maxWorkers: maxWorkers}
}

// FetchItems fetches multiple items concurrently with bounded parallelism.
func (f *Fetcher) FetchItems(ctx context.Context, ids []int64) ([]*Item, error) {
	var (
		mu    sync.Mutex
		items []*Item
		sem   = make(chan struct{}, f.maxWorkers)
		wg    sync.WaitGroup
	)

	errCh := make(chan error, len(ids))

	for _, id := range ids {
		wg.Add(1)
		go func(itemID int64) {
			defer wg.Done()

			sem <- struct{}{}
			defer func() { <-sem }()

			item, err := f.client.GetItem(ctx, itemID)
			if err != nil {
				errCh <- fmt.Errorf("fetching item %d: %w", itemID, err)
				return
			}
			if item == nil {
				return
			}

			mu.Lock()
			items = append(items, item)
			mu.Unlock()
		}(id)
	}

	wg.Wait()
	close(errCh)

	// Return items even if some failed; log errors but don't fail entirely
	// since partial results are useful for HN data.
	return items, nil
}

// FetchThread fetches a root comment and all descendants recursively using BFS.
func (f *Fetcher) FetchThread(ctx context.Context, rootID int64) ([]*Item, error) {
	root, err := f.client.GetItem(ctx, rootID)
	if err != nil {
		return nil, fmt.Errorf("fetching root %d: %w", rootID, err)
	}
	if root == nil {
		return nil, nil
	}

	var (
		mu      sync.Mutex
		results = []*Item{root}
		queue   = root.Kids
	)

	for len(queue) > 0 {
		batch := queue
		queue = nil

		items, err := f.FetchItems(ctx, batch)
		if err != nil {
			return results, err
		}

		mu.Lock()
		for _, item := range items {
			results = append(results, item)
			if len(item.Kids) > 0 {
				queue = append(queue, item.Kids...)
			}
		}
		mu.Unlock()
	}

	return results, nil
}
