# github-slack-notifier

A lightweight Cloud Run service that listens for GitHub webhook events. It sends Slack notifications when an [OpenClaw](https://openclaw.ai) AI assistant is mentioned or requested as reviewer, and can optionally forward selected pull-request lifecycle events to an authenticated OpenClaw hook.

Zero dependencies — uses only Node.js built-ins.

---

## What it does

Sends a Slack notification when any of the following happen:

| Event | Trigger |
|---|---|
| `pull_request_review` | The review body mentions the watched user |
| `pull_request_review_comment` | The diff comment mentions the watched user |
| `issue_comment` | The comment mentions the watched user |
| `pull_request` | The watched user is requested as reviewer or mentioned in the PR body |

When the optional OpenClaw hook is configured, it also forwards these normalized observer events without posting Slack noise:

| Event | OpenClaw event kind |
|---|---|
| Non-draft `pull_request.synchronize` | `pr_head_changed` |
| Non-draft `pull_request_review.submitted` | `pr_review_submitted` |
| Reply to an existing non-draft review thread | `pr_review_thread_replied` |

Initial inline comments are coalesced through the submitted-review event instead of starting one agent turn per comment. Later thread replies receive their own event. Events authored by the watched user are ignored to prevent feedback loops. The observer payload contains identifiers and bounded metadata, not PR, review, or comment bodies. OpenClaw fetches authoritative current state from GitHub before acting.

---

## Slack message format

```
[PR title] (linked)
sender reviewed your PR in lexolve/backend-api

> comment snippet here…

[View on GitHub] (button)
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `SLACK_WEBHOOK_URL` | ✅ | Slack Incoming Webhook URL |
| `GITHUB_WEBHOOK_SECRET` | Recommended; required with OpenClaw | HMAC secret to verify webhook authenticity |
| `WATCHED_GITHUB_USER` | Optional | GitHub username to watch (default: `openclaw`) |
| `OPENCLAW_HOOK_URL` | Optional, paired | HTTPS OpenClaw hook base ending in `/hooks` or full `/hooks/agent` URL; HTTP is accepted only for loopback testing |
| `OPENCLAW_HOOK_TOKEN` | Optional, paired | Dedicated bearer token for OpenClaw hook ingress |
| `OPENCLAW_AGENT_ID` | Optional | Target OpenClaw agent (default: `main`) |
| `OPENCLAW_OBSERVER_MODE` | Optional | `observe` (read-only, default) or `review` (existing patrol authority) |
| `OPENCLAW_HOOK_TIMEOUT_MS` | Optional | Observer request timeout in milliseconds (default: `10000`) |
| `PORT` | Optional | HTTP port (default: `8080`) |

---

## Deploy to Cloud Run

### 1. Build and push the Docker image

```bash
export PROJECT_ID=your-gcp-project
export IMAGE=eu.gcr.io/$PROJECT_ID/github-slack-notifier

docker build -t $IMAGE .
docker push $IMAGE
```

Or let Cloud Build do it (see `cloudbuild.yaml`).

### 2. Create secrets in Secret Manager

```bash
echo -n "https://hooks.slack.com/..." | \
  gcloud secrets create github-slack-notifier-slack-webhook-url \
  --data-file=- --project=$PROJECT_ID

echo -n "your-webhook-secret" | \
  gcloud secrets create github-slack-notifier-webhook-secret \
  --data-file=- --project=$PROJECT_ID
```

### 3. Deploy to Cloud Run

```bash
gcloud run deploy github-slack-notifier \
  --image $IMAGE \
  --platform managed \
  --region europe-west1 \
  --allow-unauthenticated \
  --update-secrets="SLACK_WEBHOOK_URL=github-slack-notifier-slack-webhook-url:latest" \
  --update-secrets="GITHUB_WEBHOOK_SECRET=github-slack-notifier-webhook-secret:latest" \
  --set-env-vars WATCHED_GITHUB_USER=your-github-username \
  --min-instances 0 \
  --max-instances 3 \
  --memory 256Mi
```

After deploy, note the service URL (e.g. `https://github-slack-notifier-xyz-ew.a.run.app`).

### 4. Configure the GitHub webhook

Go to your GitHub **org or repo → Settings → Webhooks → Add webhook**:

| Field | Value |
|---|---|
| Payload URL | `https://<your-cloud-run-url>/webhook` |
| Content type | `application/json` |
| Secret | Your `GITHUB_WEBHOOK_SECRET` value |
| Events | Select individual events: `Pull request reviews`, `Pull request review comments`, `Issue comments`, `Pull requests` |

Click **Add webhook**. GitHub will send a ping event — check Cloud Run logs to confirm it's alive.

---

## OpenClaw observer rollout

The observer is disabled unless both `OPENCLAW_HOOK_URL` and `OPENCLAW_HOOK_TOKEN` are set. Partial configuration fails startup. Enabling it also requires `GITHUB_WEBHOOK_SECRET`, so unverified GitHub payloads cannot reach the agent.

Configure the OpenClaw Gateway before adding the Cloud Run environment variables:

- Enable authenticated HTTP hooks on a dedicated path.
- Use a dedicated hook token; do not reuse Gateway, Slack, or GitHub credentials.
- Restrict `allowedAgentIds` to the intended agent.
- Keep `allowRequestSessionKey` disabled.
- Route observer turns to isolated sessions with fallback delivery disabled.
- Expose only the hook path through an approved secure network route.

The current `cloudbuild.yaml` intentionally does not mount the optional OpenClaw URL/token. Add those deployment settings only after the Gateway hook and protected secret exist. This avoids breaking the existing Slack-only deployment.

Observer delivery is best effort. A temporary OpenClaw failure is logged but returns success to GitHub; the scheduled PR patrol remains the reconciliation path. Slack mention delivery retains its existing retry behavior. GitHub's delivery ID is sent as OpenClaw's `Idempotency-Key` header and request field so webhook retries reuse the admitted hook run.

Inbound webhook bodies are capped at 1 MiB. OpenClaw receives only the normalized event, which is far below its hook body limit.

Start with `OPENCLAW_OBSERVER_MODE=observe`. Hook turns may inspect and report into OpenClaw run history but must not write to GitHub, Linear, Slack, or other external systems. Change to `review` only when the event path is ready to assume the existing PR patrol's standing review authority.

## Automated deploys via Cloud Build

The included `cloudbuild.yaml` deploys automatically on every push to `main`.

Set up the trigger:

```bash
gcloud builds triggers create github \
  --repo-name=github-slack-notifier \
  --repo-owner=lexolve \
  --branch-pattern=^main$ \
  --build-config=cloudbuild.yaml \
  --project=your-gcp-project
```

---

## Health check

```
GET /health → 200 OK
```

---

## Local development

Run the focused test suite:

```bash
npm test
```

Run in Slack-only mode:

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/... \
GITHUB_WEBHOOK_SECRET=mysecret \
WATCHED_GITHUB_USER=your-github-username \
node index.js
```

For local observer testing, point `OPENCLAW_HOOK_URL` at a controlled test receiver and provide a matching placeholder token. Do not test against the live Gateway until its hook configuration and network route have been reviewed.

Test with a sample payload:

```bash
curl -X POST http://localhost:8080/webhook \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: issue_comment" \
  -d '{
    "action": "created",
    "comment": { "body": "Hey @openclaw, can you take a look?", "html_url": "https://github.com/lexolve/backend-api/issues/1#issuecomment-1" },
    "issue": { "title": "Bug: login fails on mobile" },
    "repository": { "full_name": "lexolve/backend-api" },
    "sender": { "login": "ruben" }
  }'
```

---

## License

MIT
