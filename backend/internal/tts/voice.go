package tts

import (
	"hash/fnv"
)

// VoicePool contains curated English voices from Kokoro.
var VoicePool = []string{
	"af_heart", "af_bella", "af_nicole", "af_sarah", "af_kore",
	"am_fenrir", "am_michael", "am_puck", "am_eric", "am_adam",
	"bf_emma", "bf_isabella", "bm_george", "bm_fable",
}

// AssignVoice deterministically maps a username to a voice using FNV-1a hash.
func AssignVoice(username string) string {
	h := fnv.New32a()
	h.Write([]byte(username))
	idx := int(h.Sum32()) % len(VoicePool)
	return VoicePool[idx]
}
