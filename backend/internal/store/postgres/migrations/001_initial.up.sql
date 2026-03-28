-- Tower of HN: Initial schema

CREATE TABLE stories (
    id            BIGINT PRIMARY KEY,
    title         TEXT NOT NULL,
    url           TEXT,
    score         INT NOT NULL DEFAULT 0,
    by_user       TEXT NOT NULL,
    hn_time       TIMESTAMPTZ NOT NULL,
    descendants   INT NOT NULL DEFAULT 0,
    rank          SMALLINT,
    fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_stories_rank ON stories(rank) WHERE rank IS NOT NULL;
CREATE INDEX idx_stories_updated ON stories(updated_at);

CREATE TABLE comments (
    id            BIGINT PRIMARY KEY,
    story_id      BIGINT NOT NULL REFERENCES stories(id),
    parent_id     BIGINT,
    by_user       TEXT NOT NULL,
    text_html     TEXT NOT NULL,
    text_plain    TEXT NOT NULL,
    hn_time       TIMESTAMPTZ NOT NULL,
    dead          BOOLEAN NOT NULL DEFAULT FALSE,
    deleted       BOOLEAN NOT NULL DEFAULT FALSE,
    child_ids     BIGINT[] NOT NULL DEFAULT '{}',
    depth         SMALLINT NOT NULL DEFAULT 0,
    fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_comments_story ON comments(story_id);
CREATE INDEX idx_comments_parent ON comments(parent_id);
CREATE INDEX idx_comments_story_toplevel ON comments(story_id) WHERE parent_id IS NULL;

CREATE TABLE comment_sentiments (
    comment_id    BIGINT PRIMARY KEY REFERENCES comments(id),
    sentiment     TEXT NOT NULL,
    confidence    REAL NOT NULL,
    emotion       TEXT NOT NULL,
    model_version TEXT NOT NULL,
    analyzed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE voice_assignments (
    username      TEXT PRIMARY KEY,
    voice_id      TEXT NOT NULL,
    assigned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE threads (
    id               BIGSERIAL PRIMARY KEY,
    story_id         BIGINT NOT NULL REFERENCES stories(id),
    root_comment_id  BIGINT NOT NULL REFERENCES comments(id) UNIQUE,
    comment_count    INT NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'pending',
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_threads_story ON threads(story_id);
CREATE INDEX idx_threads_status ON threads(status);

CREATE TABLE audio_segments (
    id              BIGSERIAL PRIMARY KEY,
    thread_id       BIGINT NOT NULL REFERENCES threads(id),
    comment_id      BIGINT NOT NULL REFERENCES comments(id),
    voice_id        TEXT NOT NULL,
    file_path       TEXT NOT NULL,
    storage_backend TEXT NOT NULL DEFAULT 'local',
    duration_ms     INT NOT NULL,
    sequence_order  INT NOT NULL,
    format          TEXT NOT NULL DEFAULT 'wav',
    file_size_bytes BIGINT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audio_thread ON audio_segments(thread_id);
CREATE UNIQUE INDEX idx_audio_thread_seq ON audio_segments(thread_id, sequence_order);

CREATE TABLE thread_audio (
    thread_id        BIGINT PRIMARY KEY REFERENCES threads(id),
    file_path        TEXT NOT NULL,
    storage_backend  TEXT NOT NULL DEFAULT 'local',
    total_duration_ms INT NOT NULL,
    format           TEXT NOT NULL DEFAULT 'mp3',
    file_size_bytes  BIGINT NOT NULL,
    segment_count    INT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE avatar_states (
    comment_id    BIGINT PRIMARY KEY REFERENCES comments(id),
    username      TEXT NOT NULL,
    character     TEXT NOT NULL DEFAULT 'aavatar',
    emotion       TEXT NOT NULL,
    pose          TEXT NOT NULL DEFAULT 'explaining',
    avatar_url    TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_avatar_username ON avatar_states(username);
