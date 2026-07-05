package main

import (
	"context"
	"time"

	"github.com/multica-ai/multica/server/internal/raven"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// ravenSettleInterval is how often the sweeper looks for merged requirements
// whose observation window elapsed without a CI signal (issue #23). The CI
// webhook path settles eagerly; this is the no-signal fallback.
const ravenSettleInterval = time.Minute

func runRavenSettleSweeper(ctx context.Context, queries *db.Queries) {
	svc := raven.NewService(queries, raven.NewDispatcherFromEnv())
	ticker := time.NewTicker(ravenSettleInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			svc.SettleOverdueMerged(ctx, time.Now().Add(-raven.ObserveWindow))
		}
	}
}
