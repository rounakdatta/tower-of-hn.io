package server

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// WSMessage is the message format sent over WebSocket.
type WSMessage struct {
	Type string      `json:"type"`
	Data interface{} `json:"data"`
}

// Hub manages WebSocket connections and broadcasts.
type Hub struct {
	mu      sync.RWMutex
	clients map[*websocket.Conn]map[string]bool // conn -> subscribed topics
	logger  *slog.Logger
}

func NewHub(logger *slog.Logger) *Hub {
	return &Hub{
		clients: make(map[*websocket.Conn]map[string]bool),
		logger:  logger,
	}
}

func (h *Hub) HandleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.logger.Error("WebSocket upgrade failed", "error", err)
		return
	}

	h.mu.Lock()
	h.clients[conn] = map[string]bool{"stories": true}
	h.mu.Unlock()

	defer func() {
		h.mu.Lock()
		delete(h.clients, conn)
		h.mu.Unlock()
		conn.Close()
	}()

	// Read messages for subscribe/unsubscribe
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			break
		}

		var action struct {
			Action string   `json:"action"`
			Topics []string `json:"topics"`
		}
		if err := json.Unmarshal(msg, &action); err != nil {
			continue
		}

		h.mu.Lock()
		topics := h.clients[conn]
		switch action.Action {
		case "subscribe":
			for _, t := range action.Topics {
				topics[t] = true
			}
		case "unsubscribe":
			for _, t := range action.Topics {
				delete(topics, t)
			}
		}
		h.mu.Unlock()
	}
}

// Broadcast sends a message to all clients subscribed to the given topic.
func (h *Hub) Broadcast(topic string, msg WSMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		h.logger.Error("Failed to marshal WS message", "error", err)
		return
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	var dead []*websocket.Conn
	for conn, topics := range h.clients {
		if topics[topic] {
			if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
				h.logger.Warn("Removing dead WS connection", "error", err)
				dead = append(dead, conn)
			}
		}
	}
	for _, conn := range dead {
		delete(h.clients, conn)
		conn.Close()
	}
}
