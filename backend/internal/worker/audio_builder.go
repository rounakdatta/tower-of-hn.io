package worker

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"log/slog"
	"sort"
	"time"

	"github.com/rounakdatta/tower-of-hn.io/backend/internal/domain"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/store"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/tts"
)

const (
	SiblingSilenceMs     = 600
	ParentChildSilenceMs = 350
	SampleRate           = 24000
	BitsPerSample        = 16
	NumChannels          = 1
	MaxTTSRetries        = 3
	TTSRetryDelay        = 2 * time.Second
)

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

type orderedComment struct {
	comment  *domain.Comment
	parentID int64
	isRoot   bool
}

// BuildThreadAudio generates the full conversation audio for a thread.
func (b *AudioBuilder) BuildThreadAudio(ctx context.Context, thread *domain.Thread) (int, error) {
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

	// 1. Sequence comments: root first, then DFS pre-order by timestamp
	ordered := b.sequenceComments(comments, thread.RootCommentID)

	b.logger.Info("Sequenced comments",
		"thread_id", thread.ID,
		"sequenced_count", len(ordered),
	)

	// 2. Generate TTS for each comment with retries
	var segments []wavSegment
	var totalDurationMs int

	for i, oc := range ordered {
		if oc.comment.TextPlain == "" || oc.comment.TextPlain == "[deleted]" || oc.comment.TextPlain == "[flagged]" {
			continue
		}

		// Assign voice
		voiceID, err := b.assignVoice(ctx, oc.comment.By)
		if err != nil {
			voiceID = tts.VoicePool[0]
		}

		segKey := fmt.Sprintf("segments/%d/%d.wav", thread.ID, oc.comment.ID)

		// Check cache: if audio already exists for this comment, reuse it
		var audioData []byte
		var durationMs int
		if cached, err := b.blobs.Read(ctx, segKey); err == nil {
			data, readErr := io.ReadAll(cached)
			cached.Close()
			if readErr == nil && len(data) > 44 {
				audioData = data
				// Estimate duration from WAV: (fileSize - 44 header) / (sampleRate * 2 bytes)
				durationMs = (len(data) - 44) * 1000 / (SampleRate * NumChannels * BitsPerSample / 8)
				b.logger.Debug("Using cached audio segment",
					"comment_id", oc.comment.ID, "duration_ms", durationMs)
			}
		}

		// Generate TTS only if not cached
		if audioData == nil {
			resp, err := b.synthesizeWithRetry(ctx, oc.comment.TextPlain, voiceID)
			if err != nil {
				if oc.isRoot {
					return 0, fmt.Errorf("root comment TTS failed after retries: %w", err)
				}
				b.logger.Warn("Skipping comment after TTS failure",
					"comment_id", oc.comment.ID, "error", err)
				continue
			}
			audioData = resp.AudioData
			durationMs = resp.DurationMs

			// Cache the segment to disk
			if err := b.blobs.Write(ctx, segKey, audioData); err != nil {
				return 0, fmt.Errorf("storing segment %d: %w", oc.comment.ID, err)
			}
		}

		// Silence gap
		silenceMs := 0
		if i > 0 {
			if oc.parentID == ordered[i-1].comment.ID {
				silenceMs = ParentChildSilenceMs
			} else {
				silenceMs = SiblingSilenceMs
			}
		}

		seg := wavSegment{
			commentID:       oc.comment.ID,
			voiceID:         voiceID,
			audioData:       audioData,
			durationMs:      durationMs,
			silenceBeforeMs: silenceMs,
			sequenceOrder:   len(segments),
		}
		segments = append(segments, seg)

		if err := b.audio.UpsertSegment(ctx, &domain.AudioSegment{
			ThreadID:       thread.ID,
			CommentID:      oc.comment.ID,
			VoiceID:        voiceID,
			FilePath:       segKey,
			StorageBackend: "local",
			DurationMs:     durationMs,
			SequenceOrder:  seg.sequenceOrder,
			Format:         "wav",
			FileSizeBytes:  int64(len(audioData)),
		}); err != nil {
			b.logger.Warn("Failed to save segment metadata", "comment_id", oc.comment.ID, "error", err)
		}

		totalDurationMs += silenceMs + durationMs
	}

	if len(segments) == 0 {
		return 0, fmt.Errorf("no audio segments generated for thread %d", thread.ID)
	}

	// 3. Stitch into single WAV
	stitched, err := stitchWAV(segments)
	if err != nil {
		return 0, fmt.Errorf("stitching audio: %w", err)
	}

	// 4. Store composite
	threadKey := fmt.Sprintf("threads/%d/conversation.wav", thread.ID)
	if err := b.blobs.Write(ctx, threadKey, stitched); err != nil {
		return 0, fmt.Errorf("storing thread audio: %w", err)
	}

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

	b.logger.Info("Thread audio built",
		"thread_id", thread.ID,
		"segments", len(segments),
		"duration_ms", totalDurationMs,
	)
	return totalDurationMs, nil
}

// synthesizeWithRetry calls TTS with exponential backoff retries.
func (b *AudioBuilder) synthesizeWithRetry(ctx context.Context, text, voiceID string) (*tts.SynthesizeResponse, error) {
	var lastErr error
	for attempt := 0; attempt < MaxTTSRetries; attempt++ {
		if attempt > 0 {
			b.logger.Info("Retrying TTS", "attempt", attempt+1, "voice", voiceID)
			time.Sleep(TTSRetryDelay * time.Duration(attempt))
		}

		resp, err := b.ttsClient.Synthesize(ctx, tts.SynthesizeRequest{
			Text:    text,
			VoiceID: voiceID,
			Speed:   1.0,
			Format:  "wav",
		})
		if err == nil {
			return resp, nil
		}
		lastErr = err
	}
	return nil, fmt.Errorf("after %d attempts: %w", MaxTTSRetries, lastErr)
}

// sequenceComments orders comments: root first, then children in DFS pre-order
// sorted by timestamp. Sub-arguments play out fully before the next sibling.
func (b *AudioBuilder) sequenceComments(comments []*domain.Comment, rootID int64) []orderedComment {
	byID := make(map[int64]*domain.Comment, len(comments))
	children := make(map[int64][]*domain.Comment)

	for _, c := range comments {
		byID[c.ID] = c
		if c.ID != rootID {
			parentKey := int64(0)
			if c.ParentID != nil {
				parentKey = *c.ParentID
			}
			children[parentKey] = append(children[parentKey], c)
		}
	}

	// Sort children by timestamp at each level
	for _, kids := range children {
		sort.Slice(kids, func(i, j int) bool {
			if kids[i].HNTime.Equal(kids[j].HNTime) {
				return kids[i].ID < kids[j].ID
			}
			return kids[i].HNTime.Before(kids[j].HNTime)
		})
	}

	// Build the sequence: root always first
	var result []orderedComment

	root, ok := byID[rootID]
	if !ok {
		return nil
	}

	result = append(result, orderedComment{comment: root, parentID: 0, isRoot: true})

	// DFS from root's children
	var dfs func(parentID int64)
	dfs = func(parentID int64) {
		for _, child := range children[parentID] {
			result = append(result, orderedComment{
				comment:  child,
				parentID: parentID,
			})
			dfs(child.ID)
		}
	}
	dfs(rootID)

	return result
}

func (b *AudioBuilder) assignVoice(ctx context.Context, username string) (string, error) {
	voiceID, err := b.voices.GetVoice(ctx, username)
	if err == nil && voiceID != "" {
		return voiceID, nil
	}
	voiceID = tts.AssignVoice(username)
	_ = b.voices.AssignVoice(ctx, username, voiceID)
	return voiceID, nil
}

type wavSegment struct {
	commentID       int64
	voiceID         string
	audioData       []byte
	durationMs      int
	silenceBeforeMs int
	sequenceOrder   int
}

func stitchWAV(segments []wavSegment) ([]byte, error) {
	var allSamples []byte
	for _, seg := range segments {
		if seg.silenceBeforeMs > 0 {
			silenceSamples := SampleRate * seg.silenceBeforeMs / 1000
			silence := make([]byte, silenceSamples*NumChannels*BitsPerSample/8)
			allSamples = append(allSamples, silence...)
		}
		pcm, err := extractPCM(seg.audioData)
		if err != nil {
			return nil, fmt.Errorf("extracting PCM from segment %d: %w", seg.commentID, err)
		}
		allSamples = append(allSamples, pcm...)
	}
	return writeWAV(allSamples), nil
}

func extractPCM(wav []byte) ([]byte, error) {
	if len(wav) < 44 {
		return nil, fmt.Errorf("WAV too short: %d bytes", len(wav))
	}
	if string(wav[0:4]) != "RIFF" || string(wav[8:12]) != "WAVE" {
		return nil, fmt.Errorf("not a valid WAV file")
	}
	for i := 12; i < len(wav)-8; i++ {
		if string(wav[i:i+4]) == "data" {
			dataSize := int(binary.LittleEndian.Uint32(wav[i+4 : i+8]))
			dataStart := i + 8
			if dataStart+dataSize > len(wav) {
				return wav[dataStart:], nil
			}
			return wav[dataStart : dataStart+dataSize], nil
		}
	}
	return nil, fmt.Errorf("no data chunk found in WAV")
}

func writeWAV(pcm []byte) []byte {
	var buf bytes.Buffer
	dataSize := len(pcm)
	fileSize := 36 + dataSize
	byteRate := SampleRate * NumChannels * BitsPerSample / 8
	blockAlign := NumChannels * BitsPerSample / 8

	buf.WriteString("RIFF")
	binary.Write(&buf, binary.LittleEndian, uint32(fileSize))
	buf.WriteString("WAVE")
	buf.WriteString("fmt ")
	binary.Write(&buf, binary.LittleEndian, uint32(16))
	binary.Write(&buf, binary.LittleEndian, uint16(1))
	binary.Write(&buf, binary.LittleEndian, uint16(NumChannels))
	binary.Write(&buf, binary.LittleEndian, uint32(SampleRate))
	binary.Write(&buf, binary.LittleEndian, uint32(byteRate))
	binary.Write(&buf, binary.LittleEndian, uint16(blockAlign))
	binary.Write(&buf, binary.LittleEndian, uint16(BitsPerSample))
	buf.WriteString("data")
	binary.Write(&buf, binary.LittleEndian, uint32(dataSize))
	buf.Write(pcm)

	return buf.Bytes()
}
