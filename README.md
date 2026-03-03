# github-slack-notifier

A lightweight Cloud Run service that listens for GitHub webhook events and sends Slack notifications when [`@ken-lexolve`](https://github.com/ken-lexolve) is mentioned or reviewed.

Zero dependencies — uses only Node.js built-ins.

---

## What it does

Sends a Slack notification when any of the following happen:

| Event | Trigger |
|---|---|
| `pull_request_review` | Someone reviews a PR authored by `ken-lexolve` |
| `pull_request_review_comment` | Someone comments on a diff in a PR by `ken-lexolve` |
| `issue_comment` | Someone mentions `@ken-lexolve` in a comment, or comments on their PR/issue |
| `pull_request` | `ken-lexolve` is requested as a reviewer, or mentioned in PR body |

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
| `WATCHED_GITHUB_USER` | Optional | GitHub username to watch (default: `ken-lexolve`) |
| `PORT` | Optional | HTTP port (default: `8080`) |

---

## Deploy to Cloud Run

### 1. Build and push the Docker image

```bash
export PROJECT_ID=your-gcp-project
export IMAGE=gcr.io/$PROJECT_ID/github-slack-notifier

docker build -t $IMAGE .
docker push $IMAGE
```

Or use Cloud Build directly:

```bash
gcloud builds submit --tag $IMAGE
```

### 2. Deploy to Cloud Run

```bash
gcloud run deploy github-slack-notifier \
  --image $IMAGE \
  --platform managed \
  --region europe-west1 \
  --allow-unauthenticated \
  --set-env-vars SLACK_WEBHOOK_URL=<your-slack-webhook-url> \
  --set-env-vars GITHUB_WEBHOOK_SECRET=<your-webhook-secret> \
  --set-env-vars WATCHED_GITHUB_USER=ken-lexolve \
  --min-instances 0 \
  --max-instances 3 \
  --memory 128Mi
```

> 💡 **Secrets tip:** Use `--set-secrets` instead of `--set-env-vars` for production to pull from Google Secret Manager:
> ```bash
> --set-secrets SLACK_WEBHOOK_URL=slack-webhook-url:latest
> --set-secrets GITHUB_WEBHOOK_SECRET=github-webhook-secret:latest
> ```

After deploy, note the service URL (e.g. `https://github-slack-notifier-xyz-ew.a.run.app`).

### 3. Configure the GitHub webhook

Go to your GitHub **org or repo → Settings → Webhooks → Add webhook**:

| Field | Value |
|---|---|
| Payload URL | `https://<your-cloud-run-url>/webhook` |
| Content type | `application/json` |
| Secret | Your `GITHUB_WEBHOOK_SECRET` value |
| Events | Select individual events: `Pull request reviews`, `Pull request review comments`, `Issue comments`, `Pull requests` |

Click **Add webhook**. GitHub will send a ping event — check Cloud Run logs to confirm it's alive.

---

## Health check

```
GET /health → 200 OK
```

Cloud Run uses this endpoint automatically if configured.

---

## Local development

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/... \
GITHUB_WEBHOOK_SECRET=mysecret \
node index.js
```

Test with a sample payload:

```bash
curl -X POST http://localhost:8080/webhook \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: issue_comment" \
  -d '{
    "action": "created",
    "comment": { "body": "Hey @ken-lexolve, can you take a look?", "html_url": "https://github.com/lexolve/backend-api/issues/1#issuecomment-1" },
    "issue": { "title": "Bug: login fails on mobile" },
    "repository": { "full_name": "lexolve/backend-api" },
    "sender": { "login": "ruben" }
  }'
```

---

## License

MIT
