package worker

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"log/slog"
	"sort"

	"github.com/rounakdatta/tower-of-hn.io/backend/internal/domain"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/store"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/tts"
)

const (
	SiblingSilenceMs     = 600
	ParentChildSilenceMs = 350
	SampleRate           = 24000 // Kokoro outputs 24kHz
	BitsPerSample        = 16
	NumChannels          = 1
)

// AudioBuilder converts a comment thread into a multi-voice conversation audio file.
type AudioBuilder struct {
	comments  store.CommentStore
	voices    store.VoiceStore
	audio     store.AudioStore
	blobs     store.BlobStore
	ttsClient *tts.Client
	logger    *slog.Logger
}

func NewAudioBuilder(
	comments store.CommentStore,
	voices store.VoiceStore,
	audio store.AudioStore,
	blobs store.BlobStore,
	ttsClient *tts.Client,
	logger *slog.Logger,
) *AudioBuilder {
	return &AudioBuilder{
		comments:  comments,
		voices:    voices,
		audio:     audio,
		blobs:     blobs,
		ttsClient: ttsClient,
		logger:    logger,
	}
}

// orderedComment holds a comment with its position in the conversation.
type orderedComment struct {
	comment  *domain.Comment
	parentID int64 // who this comment is replying to (for silence gap logic)
}

// BuildThreadAudio generates the full conversation audio for a thread.
// Returns the total duration in milliseconds.
func (b *AudioBuilder) BuildThreadAudio(ctx context.Context, thread *domain.Thread) (int, error) {
	// 1. Load all comments in the thread
	comments, err := b.comments.GetThreadComments(ctx, thread.RootCommentID)
	if err != nil {
		return 0, fmt.Errorf("loading thread comments: %w", err)
	}

	if len(comments) == 0 {
		return 0, fmt.Errorf("no comments found for thread %d", thread.ID)
	}

	b.logger.Info("Building audio for thread",
		"thread_id", thread.ID,
		"comment_count", len(comments),
	)

	// 2. Order comments using DFS pre-order, children sorted by timestamp
	ordered := b.sequenceComments(comments, thread.RootCommentID)

	b.logger.Info("Sequenced comments for conversation",
		"thread_id", thread.ID,
		"sequenced_count", len(ordered),
	)

	// 3. Generate TTS for each comment and collect WAV segments
	var segments []wavSegment
	var totalDurationMs int

	for i, oc := range ordered {
		if oc.comment.TextPlain == "" || oc.comment.TextPlain == "[deleted]" || oc.comment.TextPlain == "[flagged]" {
			continue
		}

		// Assign a voice for this user
		voiceID, err := b.assignVoice(ctx, oc.comment.By)
		if err != nil {
			b.logger.Warn("Failed to assign voice, using default", "user", oc.comment.By, "error", err)
			voiceID = tts.VoicePool[0]
		}

		// Generate TTS audio
		resp, err := b.ttsClient.Synthesize(ctx, tts.SynthesizeRequest{
			Text:    oc.comment.TextPlain,
			VoiceID: voiceID,
			Speed:   1.0,
			Format:  "wav",
		})
		if err != nil {
			b.logger.Warn("Failed to synthesize comment, skipping",
				"comment_id", oc.comment.ID,
				"error", err,
			)
			continue
		}

		// Store individual segment
		segKey := fmt.Sprintf("segments/%d/%d.wav", thread.ID, oc.comment.ID)
		if err := b.blobs.Write(ctx, segKey, resp.AudioData); err != nil {
			return 0, fmt.Errorf("storing segment for comment %d: %w", oc.comment.ID, err)
		}

		// Determine silence gap before this segment
		silenceMs := 0
		if i > 0 {
			if oc.parentID == ordered[i-1].comment.ID {
				silenceMs = ParentChildSilenceMs
			} else {
				silenceMs = SiblingSilenceMs
			}
		}

		seg := wavSegment{
			commentID:      oc.comment.ID,
			voiceID:        voiceID,
			audioData:      resp.AudioData,
			durationMs:     resp.DurationMs,
			silenceBeforeMs: silenceMs,
			sequenceOrder:  len(segments),
		}
		segments = append(segments, seg)

		// Save segment metadata to DB
		if err := b.audio.UpsertSegment(ctx, &domain.AudioSegment{
			ThreadID:      thread.ID,
			CommentID:     oc.comment.ID,
			VoiceID:       voiceID,
			FilePath:      segKey,
			StorageBackend: "local",
			DurationMs:    resp.DurationMs,
			SequenceOrder: seg.sequenceOrder,
			Format:        "wav",
			FileSizeBytes: int64(len(resp.AudioData)),
		}); err != nil {
			b.logger.Warn("Failed to save segment metadata", "comment_id", oc.comment.ID, "error", err)
		}

		totalDurationMs += silenceMs + resp.DurationMs
	}

	if len(segments) == 0 {
		return 0, fmt.Errorf("no audio segments generated for thread %d", thread.ID)
	}

	// 4. Stitch all segments into a single WAV file
	stitched, err := stitchWAV(segments)
	if err != nil {
		return 0, fmt.Errorf("stitching audio: %w", err)
	}

	// 5. Store the composite audio
	threadKey := fmt.Sprintf("threads/%d/conversation.wav", thread.ID)
	if err := b.blobs.Write(ctx, threadKey, stitched); err != nil {
		return 0, fmt.Errorf("storing thread audio: %w", err)
	}

	// 6. Save thread audio metadata
	if err := b.audio.UpsertThreadAudio(ctx, &domain.ThreadAudio{
		ThreadID:        thread.ID,
		FilePath:        threadKey,
		StorageBackend:  "local",
		TotalDurationMs: totalDurationMs,
		Format:          "wav",
		FileSizeBytes:   int64(len(stitched)),
		SegmentCount:    len(segments),
	}); err != nil {
		return 0, fmt.Errorf("saving thread audio metadata: %w", err)
	}

	b.logger.Info("Thread audio built successfully",
		"thread_id", thread.ID,
		"segments", len(segments),
		"duration_ms", totalDurationMs,
	)

	return totalDurationMs, nil
}

// sequenceComments orders comments in DFS pre-order with children sorted by timestamp.
// This produces a natural conversation flow where sub-arguments play out fully
// before moving to the next sibling branch.
func (b *AudioBuilder) sequenceComments(comments []*domain.Comment, rootID int64) []orderedComment {
	// Build a map of comment ID → comment and parent → children
	byID := make(map[int64]*domain.Comment, len(comments))
	children := make(map[int64][]*domain.Comment)

	for _, c := range comments {
		byID[c.ID] = c
		parentKey := int64(0)
		if c.ParentID != nil {
			parentKey = *c.ParentID
		}
		// Root comments have parentKey == 0 or their parent is the story
		if c.ID == rootID {
			parentKey = -1 // sentinel for root
		}
		children[parentKey] = append(children[parentKey], c)
	}

	// Sort each parent's children by timestamp (chronological)
	for _, kids := range children {
		sort.Slice(kids, func(i, j int) bool {
			if kids[i].HNTime.Equal(kids[j].HNTime) {
				return kids[i].ID < kids[j].ID // deterministic tiebreaker
			}
			return kids[i].HNTime.Before(kids[j].HNTime)
		})
	}

	// DFS pre-order traversal starting from root
	var result []orderedComment
	var dfs func(commentID int64, parentID int64)
	dfs = func(commentID int64, parentID int64) {
		c, ok := byID[commentID]
		if !ok {
			return
		}
		result = append(result, orderedComment{
			comment:  c,
			parentID: parentID,
		})
		for _, child := range children[commentID] {
			dfs(child.ID, commentID)
		}
	}

	// Start from root
	root, ok := byID[rootID]
	if !ok {
		return nil
	}
	result = append(result, orderedComment{comment: root, parentID: 0})
	for _, child := range children[rootID] {
		dfs(child.ID, rootID)
	}

	return result
}

// assignVoice gets or creates a deterministic voice assignment for a username.
func (b *AudioBuilder) assignVoice(ctx context.Context, username string) (string, error) {
	// Check if already assigned
	voiceID, err := b.voices.GetVoice(ctx, username)
	if err == nil && voiceID != "" {
		return voiceID, nil
	}

	// Assign deterministically
	voiceID = tts.AssignVoice(username)
	if err := b.voices.AssignVoice(ctx, username, voiceID); err != nil {
		// Non-fatal — we can still use the computed voice
		b.logger.Warn("Failed to persist voice assignment", "username", username, "error", err)
	}

	return voiceID, nil
}

// wavSegment represents one comment's audio in the conversation.
type wavSegment struct {
	commentID       int64
	voiceID         string
	audioData       []byte // Full WAV file
	durationMs      int
	silenceBeforeMs int
	sequenceOrder   int
}

// stitchWAV combines multiple WAV segments with silence gaps into a single WAV file.
// Assumes all segments are 24kHz, 16-bit, mono (Kokoro's output format).
func stitchWAV(segments []wavSegment) ([]byte, error) {
	var allSamples []byte

	for _, seg := range segments {
		// Add silence before this segment
		if seg.silenceBeforeMs > 0 {
			silenceSamples := SampleRate * seg.silenceBeforeMs / 1000
			silence := make([]byte, silenceSamples*NumChannels*BitsPerSample/8)
			allSamples = append(allSamples, silence...)
		}

		// Extract raw PCM data from WAV (skip 44-byte header)
		pcm, err := extractPCM(seg.audioData)
		if err != nil {
			return nil, fmt.Errorf("extracting PCM from segment %d: %w", seg.commentID, err)
		}
		allSamples = append(allSamples, pcm...)
	}

	// Write a new WAV file with the combined samples
	return writeWAV(allSamples), nil
}

// extractPCM strips the WAV header and returns raw PCM data.
// Handles standard 44-byte headers and extended headers with "data" chunk search.
func extractPCM(wav []byte) ([]byte, error) {
	if len(wav) < 44 {
		return nil, fmt.Errorf("WAV too short: %d bytes", len(wav))
	}

	// Verify RIFF header
	if string(wav[0:4]) != "RIFF" || string(wav[8:12]) != "WAVE" {
		return nil, fmt.Errorf("not a valid WAV file")
	}

	// Search for "data" chunk
	for i := 12; i < len(wav)-8; i++ {
		if string(wav[i:i+4]) == "data" {
			dataSize := int(binary.LittleEndian.Uint32(wav[i+4 : i+8]))
			dataStart := i + 8
			if dataStart+dataSize > len(wav) {
				// Use remaining bytes
				return wav[dataStart:], nil
			}
			return wav[dataStart : dataStart+dataSize], nil
		}
	}

	return nil, fmt.Errorf("no data chunk found in WAV")
}

// writeWAV creates a WAV file from raw PCM data.
func writeWAV(pcm []byte) []byte {
	var buf bytes.Buffer
	dataSize := len(pcm)
	fileSize := 36 + dataSize
	byteRate := SampleRate * NumChannels * BitsPerSample / 8
	blockAlign := NumChannels * BitsPerSample / 8

	// RIFF header
	buf.WriteString("RIFF")
	binary.Write(&buf, binary.LittleEndian, uint32(fileSize))
	buf.WriteString("WAVE")

	// fmt chunk
	buf.WriteString("fmt ")
	binary.Write(&buf, binary.LittleEndian, uint32(16))        // chunk size
	binary.Write(&buf, binary.LittleEndian, uint16(1))         // PCM format
	binary.Write(&buf, binary.LittleEndian, uint16(NumChannels))
	binary.Write(&buf, binary.LittleEndian, uint32(SampleRate))
	binary.Write(&buf, binary.LittleEndian, uint32(byteRate))
	binary.Write(&buf, binary.LittleEndian, uint16(blockAlign))
	binary.Write(&buf, binary.LittleEndian, uint16(BitsPerSample))

	// data chunk
	buf.WriteString("data")
	binary.Write(&buf, binary.LittleEndian, uint32(dataSize))
	buf.Write(pcm)

	return buf.Bytes()
}
