package logsetu

import (
	"context"
	"log/slog"
	"strings"
)

// SlogOptions configure the log/slog handler.
type SlogOptions struct {
	// Level is the minimum slog level forwarded. Default slog.LevelInfo.
	Level slog.Leveler
}

// SlogHandler returns a slog.Handler that ships records through this client:
//
//	slog.SetDefault(slog.New(client.SlogHandler(nil)))
//	slog.ErrorContext(ctx, "payment failed", "orderId", 456, "error", err)
//
// Attributes become meta (groups become nested objects). When ctx comes from a request wrapped by
// Middleware, the request id, method and path are attached too. A "source" attribute overrides the source.
func (c *Client) SlogHandler(opts *SlogOptions) slog.Handler {
	h := &slogHandler{client: c, level: slog.LevelInfo}
	if opts != nil && opts.Level != nil {
		h.level = opts.Level
	}
	return h
}

type slogHandler struct {
	client *Client
	level  slog.Leveler
	attrs  []slog.Attr // pre-bound via WithAttrs, already nested inside groups
	groups []string
}

func (h *slogHandler) Enabled(_ context.Context, l slog.Level) bool {
	return l >= h.level.Level() && h.client.core.enabled
}

func (h *slogHandler) Handle(ctx context.Context, r slog.Record) error {
	meta := Meta{}
	for _, a := range h.attrs {
		addAttr(meta, a)
	}
	var recAttrs []slog.Attr
	r.Attrs(func(a slog.Attr) bool {
		recAttrs = append(recAttrs, a)
		return true
	})
	target := meta
	for _, g := range h.groups {
		sub, ok := target[g].(Meta)
		if !ok {
			sub = Meta{}
			target[g] = sub
		}
		target = sub
	}
	for _, a := range recAttrs {
		addAttr(target, a)
	}
	if rc := requestContext(ctx); rc != nil {
		if _, taken := meta["request"]; !taken {
			meta["request"] = rc
		}
	}
	h.client.Log(slogLevel(r.Level), r.Message, meta)
	return nil
}

func (h *slogHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	if len(attrs) == 0 {
		return h
	}
	clone := *h
	if len(h.groups) == 0 {
		clone.attrs = append(append([]slog.Attr{}, h.attrs...), attrs...)
		return &clone
	}
	// Nest the new attrs inside the open groups so they render at the right depth.
	args := make([]any, len(attrs))
	for i, a := range attrs {
		args[i] = a
	}
	nested := slog.Group(h.groups[len(h.groups)-1], args...)
	for i := len(h.groups) - 2; i >= 0; i-- {
		nested = slog.Group(h.groups[i], nested)
	}
	clone.attrs = append(append([]slog.Attr{}, h.attrs...), nested)
	return &clone
}

func (h *slogHandler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	clone := *h
	clone.groups = append(append([]string{}, h.groups...), name)
	return &clone
}

func addAttr(m Meta, a slog.Attr) {
	a.Value = a.Value.Resolve()
	if a.Equal(slog.Attr{}) {
		return
	}
	if a.Value.Kind() == slog.KindGroup {
		group := a.Value.Group()
		if len(group) == 0 {
			return
		}
		target := m
		if a.Key != "" {
			sub, ok := m[a.Key].(Meta)
			if !ok {
				sub = Meta{}
				m[a.Key] = sub
			}
			target = sub
		}
		for _, ga := range group {
			addAttr(target, ga)
		}
		return
	}
	m[a.Key] = a.Value.Any()
}

func slogLevel(l slog.Level) Level {
	switch {
	case l >= slog.LevelError+4:
		return LevelFatal
	case l >= slog.LevelError:
		return LevelError
	case l >= slog.LevelWarn:
		return LevelWarn
	case l >= slog.LevelInfo:
		return LevelInfo
	}
	return LevelDebug
}

// ParseLevel converts "debug", "info", "warn"/"warning", "error" and "fatal"/"critical" to a Level.
func ParseLevel(s string) Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return LevelDebug
	case "warn", "warning":
		return LevelWarn
	case "error":
		return LevelError
	case "fatal", "critical":
		return LevelFatal
	}
	return LevelInfo
}
