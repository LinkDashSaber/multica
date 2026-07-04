# @multica/raven-workflows

Deployable trigger.dev (v4) project containing Raven workflows built with
`@multica/raven-sdk`. Tasks live in `src/trigger/`.

## Deploy

The self-hosted trigger.dev instance is documented in `infra/trigger/README.md`
(webapp/API at `http://localhost:8030`, project ref in `infra/trigger/.env.local`
as `TRIGGER_PROJECT_REF`).

One-time login on the deploying machine:

```bash
npx trigger.dev@v4 login -a http://localhost:8030 --profile self-hosted
docker login -u registry-user localhost:5001
```

Then, from this directory:

```bash
TRIGGER_PROJECT_REF=proj_xxx pnpm dlx trigger.dev@v4 deploy --profile self-hosted
```

Runtime env vars for deployed tasks (set them in the trigger.dev project env):

- `RAVEN_API_URL` — multica control plane URL (default `http://localhost:8080`)
- `RAVEN_CONTROL_TOKEN` — bearer token for the control plane
- `RAVEN_HELLO_AGENT_ID` — optional; when set, `hello-workflow` dispatches a
  real sub-issue to that agent instead of just recording evidence.
