# Self-hosted trigger.dev v4 (local dev)

Single-machine docker compose stack, based on the official
[trigger.dev self-hosting setup](https://trigger.dev/docs/self-hosting/docker)
(`hosting/docker/` in the trigger.dev repo, tag `v4-beta`).

## Layout

- `webapp/docker-compose.yml` — webapp, postgres, redis, electric, clickhouse, docker registry, minio
- `worker/docker-compose.yml` — supervisor + docker socket proxy (runs deployed task containers)
- `.env.local` — secrets and instance config (gitignored, DO NOT COMMIT)
- `.env.example` — upstream reference

Local port changes vs upstream defaults (to avoid collisions on this machine):

| Service  | Host port | Note |
| -------- | --------- | ---- |
| webapp   | 8030      | upstream default |
| postgres | 5440      | upstream 5433 collides with multica-postgres |
| registry | 5001      | upstream 5000 collides with macOS AirPlay |
| redis    | 6389      | |
| minio    | 9000/9001 | |
| clickhouse | 9123/9090 | |

## Start / stop

Run from `infra/trigger/`:

```bash
docker compose --env-file .env.local -f webapp/docker-compose.yml -f worker/docker-compose.yml up -d
docker compose --env-file .env.local -f webapp/docker-compose.yml -f worker/docker-compose.yml down
# wipe all data:
docker compose --env-file .env.local -f webapp/docker-compose.yml -f worker/docker-compose.yml down -v
```

## Instance facts

- Webapp URL / API URL: `http://localhost:8030`
- Login: magic-link auth; no email transport is configured, so the link is printed to
  `docker compose -p trigger logs webapp` (search for "magic link" / `/magic`).
- Login email: `raven@local.dev`
- Org: **raven** (slug `raven-4293`) — Project: **raven** (slug `raven-iKVU`),
  ref in `.env.local` (`TRIGGER_PROJECT_REF`)
- Prod env var `RAVEN_API_URL` is set to `http://host.docker.internal:8080` so task
  containers can reach the Raven control plane running on the host. `RAVEN_CONTROL_TOKEN`
  still needs to be set once the control-plane auth story lands.
- API keys: dev + prod secret keys live in `.env.local`
  (`TRIGGER_DEV_API_KEY` / `TRIGGER_PROD_API_KEY`). Also visible in the webapp under
  Project → API keys.

## Deploying tasks

One-time on the deploying machine:

```bash
npx trigger.dev@v4 login -a http://localhost:8030 --profile self-hosted
docker login -u registry-user localhost:5001   # password: very-secure-indeed
```

Then from a tasks project (with `trigger.config.ts` pointing at the project ref):

```bash
npx trigger.dev@v4 deploy --profile self-hosted
```

No `--self-hosted` flag exists in the v4 GA CLI; the webapp tells the CLI to build
locally and push to the bundled registry (`localhost:5001`, namespace `trigger`).

## Triggering runs via REST

```bash
# trigger (use the prod key for deployed tasks, dev key for `trigger.dev dev` runs)
curl -s -X POST http://localhost:8030/api/v1/tasks/<task-id>/trigger \
  -H "Authorization: Bearer $TRIGGER_PROD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"payload": {"hello": "world"}}'
# => {"id":"run_..."}

# poll
curl -s http://localhost:8030/api/v3/runs/<run-id> \
  -H "Authorization: Bearer $TRIGGER_PROD_API_KEY"
# status: QUEUED -> EXECUTING -> COMPLETED
```
