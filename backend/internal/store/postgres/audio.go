package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/domain"
)

type AudioStoreImpl struct {
	db *DB
}

func NewAudioStore(db *DB) *AudioStoreImpl {
	return &AudioStoreImpl{db: db}
}

func (a *AudioStoreImpl) GetThreadAudio(ctx context.Context, threadID int64) (*domain.ThreadAudio, error) {
	query := `
		SELECT thread_id, file_path, storage_backend, total_duration_ms, format, file_size_bytes, segment_count, created_at
		FROM thread_audio
		WHERE thread_id = @thread_id`

	ta := &domain.ThreadAudio{}
	err := a.db.Pool.QueryRow(ctx, query, pgx.NamedArgs{"thread_id": threadID}).Scan(
		&ta.ThreadID, &ta.FilePath, &ta.StorageBackend,
		&ta.TotalDurationMs, &ta.Format, &ta.FileSizeBytes,
		&ta.SegmentCount, &ta.CreatedAt,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, fmt.Errorf("thread audio for thread %d not found: %w", threadID, err)
		}
		return nil, fmt.Errorf("getting thread audio for thread %d: %w", threadID, err)
	}
	return ta, nil
}

func (a *AudioStoreImpl) UpsertSegment(ctx context.Context, seg *domain.AudioSegment) error {
	query := `
		INSERT INTO audio_segments (thread_id, comment_id, voice_id, file_path, storage_backend, duration_ms, sequence_order, format, file_size_bytes, created_at)
		VALUES (@thread_id, @comment_id, @voice_id, @file_path, @storage_backend, @duration_ms, @sequence_order, @format, @file_size_bytes, NOW())
		ON CONFLICT (thread_id, sequence_order) DO UPDATE SET
			comment_id      = EXCLUDED.comment_id,
			voice_id        = EXCLUDED.voice_id,
			file_path       = EXCLUDED.file_path,
			storage_backend = EXCLUDED.storage_backend,
			duration_ms     = EXCLUDED.duration_ms,
			format          = EXCLUDED.format,
			file_size_bytes = EXCLUDED.file_size_bytes,
			created_at      = NOW()
		RETURNING id`

	err := a.db.Pool.QueryRow(ctx, query, pgx.NamedArgs{
		"thread_id":       seg.ThreadID,
		"comment_id":      seg.CommentID,
		"voice_id":        seg.VoiceID,
		"file_path":       seg.FilePath,
		"storage_backend": seg.StorageBackend,
		"duration_ms":     seg.DurationMs,
		"sequence_order":  seg.SequenceOrder,
		"format":          seg.Format,
		"file_size_bytes": seg.FileSizeBytes,
	}).Scan(&seg.ID)
	if err != nil {
		return fmt.Errorf("upserting audio segment for thread %d seq %d: %w", seg.ThreadID, seg.SequenceOrder, err)
	}
	return nil
}

func (a *AudioStoreImpl) UpsertThreadAudio(ctx context.Context, ta *domain.ThreadAudio) error {
	query := `
		INSERT INTO thread_audio (thread_id, file_path, storage_backend, total_duration_ms, format, file_size_bytes, segment_count, created_at)
		VALUES (@thread_id, @file_path, @storage_backend, @total_duration_ms, @format, @file_size_bytes, @segment_count, NOW())
		ON CONFLICT (thread_id) DO UPDATE SET
			file_path         = EXCLUDED.file_path,
			storage_backend   = EXCLUDED.storage_backend,
			total_duration_ms = EXCLUDED.total_duration_ms,
			format            = EXCLUDED.format,
			file_size_bytes   = EXCLUDED.file_size_bytes,
			segment_count     = EXCLUDED.segment_count,
			created_at        = NOW()`

	_, err := a.db.Pool.Exec(ctx, query, pgx.NamedArgs{
		"thread_id":         ta.ThreadID,
		"file_path":         ta.FilePath,
		"storage_backend":   ta.StorageBackend,
		"total_duration_ms": ta.TotalDurationMs,
		"format":            ta.Format,
		"file_size_bytes":   ta.FileSizeBytes,
		"segment_count":     ta.SegmentCount,
	})
	if err != nil {
		return fmt.Errorf("upserting thread audio for thread %d: %w", ta.ThreadID, err)
	}
	return nil
}

func (a *AudioStoreImpl) GetSegments(ctx context.Context, threadID int64) ([]*domain.AudioSegment, error) {
	query := `
		SELECT id, thread_id, comment_id, voice_id, file_path, storage_backend, duration_ms, sequence_order, format, file_size_bytes, created_at
		FROM audio_segments
		WHERE thread_id = @thread_id
		ORDER BY sequence_order ASC`

	rows, err := a.db.Pool.Query(ctx, query, pgx.NamedArgs{"thread_id": threadID})
	if err != nil {
		return nil, fmt.Errorf("querying audio segments for thread %d: %w", threadID, err)
	}
	defer rows.Close()

	var segments []*domain.AudioSegment
	for rows.Next() {
		seg := &domain.AudioSegment{}
		if err := rows.Scan(
			&seg.ID, &seg.ThreadID, &seg.CommentID, &seg.VoiceID,
			&seg.FilePath, &seg.StorageBackend, &seg.DurationMs,
			&seg.SequenceOrder, &seg.Format, &seg.FileSizeBytes, &seg.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("scanning audio segment row: %w", err)
		}
		segments = append(segments, seg)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating audio segment rows: %w", err)
	}
	return segments, nil
}
