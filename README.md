# github-slack-notifier

A lightweight Cloud Run service that listens for GitHub webhook events and sends Slack notifications when an [OpenClaw](https://openclaw.ai) AI assistant is mentioned or reviewed on GitHub.

Zero dependencies — uses only Node.js built-ins.

---

## What it does

Sends a Slack notification when any of the following happen:

| Event | Trigger |
|---|---|
| `pull_request_review` | Someone reviews a PR authored by the watched user |
| `pull_request_review_comment` | Someone comments on a diff in a PR by the watched user |
| `issue_comment` | Someone mentions the watched user in a comment, or comments on their PR/issue |
| `pull_request` | The watched user is requested as a reviewer, or mentioned in a PR body |

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
| `GITHUB_WEBHOOK_SECRET` | Recommended | HMAC secret to verify webhook authenticity |
| `WATCHED_GITHUB_USER` | Optional | GitHub username to watch (default: `openclaw`) |
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

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/... \
GITHUB_WEBHOOK_SECRET=mysecret \
WATCHED_GITHUB_USER=your-github-username \
node index.js
```

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
