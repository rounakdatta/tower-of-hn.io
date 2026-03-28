package worker

// AudioBuilder handles converting a comment thread into a multi-voice conversation audio file.
//
// The ordering algorithm:
// 1. Start with the root comment (depth 0)
// 2. For each comment, process direct children chronologically
// 3. Nested replies are processed immediately after (DFS pre-order)
// 4. Silence gaps: 500ms between siblings, 300ms parent→child
//
// This ensures sub-arguments play out fully before moving to the next thread branch.

const (
	SiblingSilenceMs     = 500
	ParentChildSilenceMs = 300
)

// TODO: Implement BuildThreadAudio that:
// 1. Loads thread comments in DFS order
// 2. For each comment: assign voice, call TTS, store audio segment
// 3. Stitch segments with silence gaps
// 4. Store composite audio file
// 5. Return thread audio metadata
