package server

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/handler"
	"github.com/rounakdatta/tower-of-hn.io/backend/internal/store"
)

type Server struct {
	router     *chi.Mux
	httpServer *http.Server
	hub        *Hub
	logger     *slog.Logger
}

type Dependencies struct {
	Stories   store.StoryStore
	Threads   store.ThreadStore
	Comments  store.CommentStore
	Audio     store.AudioStore
	Blobs     store.BlobStore
	Sentiment store.SentimentStore
	Voices    store.VoiceStore
	Avatars   store.AvatarStore
}

func New(port int, deps Dependencies, logger *slog.Logger) *Server {
	r := chi.NewRouter()
	hub := NewHub(logger)

	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(corsMiddleware)

	storyHandler := handler.NewStoryHandler(deps.Stories)
	threadHandler := handler.NewThreadHandler(deps.Threads, deps.Comments)
	audioHandler := handler.NewAudioHandler(deps.Audio, deps.Blobs)

	r.Route("/api", func(r chi.Router) {
		r.Get("/health", handler.HandleHealth)

		r.Get("/stories", storyHandler.List)
		r.Get("/stories/{id}", storyHandler.Get)
		r.Get("/stories/{id}/threads", threadHandler.ListForStory)

		r.Get("/threads/{threadId}", threadHandler.Get)

		r.Get("/audio/{threadId}/stream", audioHandler.Stream)
	})

	r.Get("/ws", hub.HandleWS)

	return &Server{
		router: r,
		httpServer: &http.Server{
			Addr:         fmt.Sprintf(":%d", port),
			Handler:      r,
			ReadTimeout:  15 * time.Second,
			WriteTimeout: 60 * time.Second,
			IdleTimeout:  120 * time.Second,
		},
		hub:    hub,
		logger: logger,
	}
}

func (s *Server) Hub() *Hub {
	return s.hub
}

func (s *Server) Start() error {
	s.logger.Info("Starting HTTP server", "addr", s.httpServer.Addr)
	return s.httpServer.ListenAndServe()
}

func (s *Server) Shutdown(ctx context.Context) error {
	s.logger.Info("Shutting down HTTP server")
	return s.httpServer.Shutdown(ctx)
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}
