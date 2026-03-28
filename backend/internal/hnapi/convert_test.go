package hnapi

import (
	"testing"
)

func TestStripHTML(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "plain text",
			input: "Hello world",
			want:  "Hello world",
		},
		{
			name:  "paragraph tags",
			input: "First paragraph.<p>Second paragraph.",
			want:  "First paragraph.\n\nSecond paragraph.",
		},
		{
			name:  "link tags",
			input: `Check out <a href="https://example.com">this link</a> here.`,
			want:  "Check out this link here.",
		},
		{
			name:  "italic tags",
			input: "This is <i>important</i> stuff.",
			want:  "This is important stuff.",
		},
		{
			name:  "code block",
			input: "Here is code:<p><pre><code>func main() {}\n</code></pre>",
			want:  "Here is code:\n\nfunc main() {}",
		},
		{
			name:  "html entities",
			input: "AT&amp;T said &quot;hello&quot; and it&#x27;s fine",
			want:  `AT&T said "hello" and it's fine`,
		},
		{
			name:  "br tags",
			input: "line one<br>line two<br/>line three",
			want:  "line one\nline two\nline three",
		},
		{
			name:  "nested tags",
			input: `<p>Here&#x27;s a <a href="https://example.com" rel="nofollow">link</a> with <i>italic</i>.</p>`,
			want:  "Here's a link with italic.",
		},
		{
			name:  "empty string",
			input: "",
			want:  "",
		},
		{
			name:  "typical HN comment",
			input: `I&#x27;ve been using this for a while.<p>The main issue is performance - it&#x27;s about 10x slower than the C version.<p>That said, the API is much nicer: <a href="https:&#x2F;&#x2F;docs.example.com" rel="nofollow">https:&#x2F;&#x2F;docs.example.com</a>`,
			want:  "I've been using this for a while.\n\nThe main issue is performance - it's about 10x slower than the C version.\n\nThat said, the API is much nicer: https://docs.example.com",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := StripHTML(tt.input)
			if got != tt.want {
				t.Errorf("StripHTML(%q)\n  got:  %q\n  want: %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestItemToStory(t *testing.T) {
	item := &Item{
		ID:          12345,
		Type:        "story",
		By:          "pg",
		Time:        1700000000,
		Title:       "Test Story",
		URL:         "https://example.com",
		Score:       100,
		Descendants: 42,
		Kids:        []int64{1, 2, 3},
	}

	story := ItemToStory(item)
	if story.ID != 12345 {
		t.Errorf("expected ID 12345, got %d", story.ID)
	}
	if story.By != "pg" {
		t.Errorf("expected By 'pg', got %q", story.By)
	}
	if story.Score != 100 {
		t.Errorf("expected Score 100, got %d", story.Score)
	}
}

func TestItemToComment(t *testing.T) {
	item := &Item{
		ID:     99999,
		Type:   "comment",
		By:     "dang",
		Time:   1700000000,
		Text:   "Great <i>point</i>.<p>I agree.",
		Parent: 12345,
		Kids:   []int64{100000},
	}

	comment := ItemToComment(item, 12345, 0)
	if comment.ID != 99999 {
		t.Errorf("expected ID 99999, got %d", comment.ID)
	}
	if comment.ParentID != nil {
		t.Errorf("expected nil ParentID for top-level comment, got %v", *comment.ParentID)
	}
	if comment.TextPlain != "Great point.\n\nI agree." {
		t.Errorf("unexpected TextPlain: %q", comment.TextPlain)
	}
	if comment.Depth != 0 {
		t.Errorf("expected depth 0, got %d", comment.Depth)
	}

	// Nested comment
	nested := &Item{
		ID:     100000,
		Type:   "comment",
		By:     "tptacek",
		Time:   1700001000,
		Text:   "Disagree.",
		Parent: 99999,
	}
	nestedComment := ItemToComment(nested, 12345, 1)
	if nestedComment.ParentID == nil || *nestedComment.ParentID != 99999 {
		t.Errorf("expected ParentID 99999, got %v", nestedComment.ParentID)
	}
}

func TestItemToCommentDeleted(t *testing.T) {
	item := &Item{
		ID:      88888,
		Type:    "comment",
		Deleted: true,
		Parent:  12345,
	}

	comment := ItemToComment(item, 12345, 0)
	if comment.By != "[deleted]" {
		t.Errorf("expected By '[deleted]', got %q", comment.By)
	}
	if comment.TextPlain != "[deleted]" {
		t.Errorf("expected TextPlain '[deleted]', got %q", comment.TextPlain)
	}
}
