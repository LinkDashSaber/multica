package raven

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

// Dispatcher triggers workflow runs on the self-hosted trigger.dev instance
// (ADR-0002). Configured entirely from env so local dev without trigger.dev
// still boots — an unconfigured dispatcher reports !Configured() and the
// caller records the run as pending.
type Dispatcher struct {
	APIURL    string
	SecretKey string
	Client    *http.Client
}

func NewDispatcherFromEnv() *Dispatcher {
	return &Dispatcher{
		APIURL:    strings.TrimRight(strings.TrimSpace(os.Getenv("RAVEN_TRIGGER_API_URL")), "/"),
		SecretKey: strings.TrimSpace(os.Getenv("RAVEN_TRIGGER_SECRET_KEY")),
		Client:    &http.Client{Timeout: 15 * time.Second},
	}
}

func (d *Dispatcher) Configured() bool {
	return d != nil && d.APIURL != "" && d.SecretKey != ""
}

// TriggerRun starts the trigger.dev task named taskID with payload and
// returns the trigger.dev run id.
func (d *Dispatcher) TriggerRun(ctx context.Context, taskID string, payload any) (string, error) {
	body, err := json.Marshal(map[string]any{"payload": payload})
	if err != nil {
		return "", err
	}
	url := fmt.Sprintf("%s/api/v1/tasks/%s/trigger", d.APIURL, taskID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+d.SecretKey)

	res, err := d.Client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		var buf bytes.Buffer
		_, _ = buf.ReadFrom(res.Body)
		return "", fmt.Errorf("trigger.dev returned %d: %s", res.StatusCode, strings.TrimSpace(buf.String()))
	}
	var out struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return "", err
	}
	if out.ID == "" {
		return "", fmt.Errorf("trigger.dev response missing run id")
	}
	return out.ID, nil
}
