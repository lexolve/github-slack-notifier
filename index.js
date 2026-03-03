const http = require("http");
const https = require("https");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const WATCHED_USER = process.env.WATCHED_GITHUB_USER || "openclaw";

// Cloud Tasks config for 5-min PR check delay
const CLOUD_TASKS_PROJECT = process.env.CLOUD_TASKS_PROJECT;
const CLOUD_TASKS_LOCATION = process.env.CLOUD_TASKS_LOCATION || "europe-west1";
const CLOUD_TASKS_QUEUE = process.env.CLOUD_TASKS_QUEUE || "pr-review-check";
const SERVICE_URL = process.env.SERVICE_URL; // e.g. https://github-slack-notifier-xxx.a.run.app

if (!SLACK_WEBHOOK_URL) {
  console.error("FATAL: SLACK_WEBHOOK_URL is not set");
  process.exit(1);
}

function verifySignature(secret, payload, signature) {
  if (!secret) return true;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature || ""));
  } catch {
    return false;
  }
}

function isRelevant(event, payload) {
  const body = payload.comment?.body || payload.review?.body || payload.pull_request?.body || "";
  const mentionPattern = new RegExp(`@${WATCHED_USER}\\b`, "i");
  const isMentioned = mentionPattern.test(body);
  const isPRAuthor =
    payload.pull_request?.user?.login?.toLowerCase() === WATCHED_USER.toLowerCase();
  const isReviewRequested =
    event === "pull_request" &&
    payload.action === "review_requested" &&
    payload.requested_reviewer?.login?.toLowerCase() === WATCHED_USER.toLowerCase();
  const isNewPR = event === "pull_request" && payload.action === "opened";

  if (event === "pull_request_review" && isPRAuthor) return true;
  if (event === "pull_request_review_comment" && isPRAuthor) return true;
  if (event === "issue_comment" && (isMentioned || isPRAuthor)) return true;
  if (event === "pull_request" && (isMentioned || isReviewRequested || isNewPR)) return true;

  return false;
}

function buildSlackMessage(event, payload) {
  const repo = payload.repository?.full_name || "unknown/repo";
  const sender = payload.sender?.login || "someone";
  const pr = payload.pull_request;
  const issue = payload.issue;
  const review = payload.review;
  const comment = payload.comment;

  const title = pr?.title || issue?.title || "(no title)";
  const url =
    pr?.html_url || issue?.html_url || review?.html_url || comment?.html_url || "#";
  let snippet = comment?.body || review?.body || pr?.body || "";
  if (snippet.length > 200) snippet = snippet.slice(0, 200) + "\u2026";

  let action = "mentioned you";
  if (event === "pull_request_review") action = "reviewed your PR";
  if (event === "pull_request_review_comment") action = "commented on your PR diff";
  if (event === "issue_comment") action = "commented on an issue/PR";
  if (event === "pull_request" && payload.action === "review_requested")
    action = "requested your review";
  if (event === "pull_request" && payload.action === "opened")
    action = `opened a new PR in \`${repo}\` — will check for review comments in 5 min`;

  return {
    text: `GitHub notification for @${WATCHED_USER}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*<${url}|${title}>*\n*${sender}* ${action}`,
        },
      },
      snippet && payload.action !== "opened"
        ? {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `> ${snippet.replace(/\n/g, "\n> ")}`,
            },
          }
        : null,
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View on GitHub" },
            url,
          },
        ],
      },
    ].filter(Boolean),
  };
}

// Build the Slack action message sent after the 5-min delay
function buildPrCheckMessage(prNumber, repo, prUrl, prTitle) {
  return {
    text: `PR review check: ${prTitle}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            `🔔 *5-min PR check triggered*`,
            `*<${prUrl}|${prTitle}>* in \`${repo}\``,
            ``,
            `Please check PR #${prNumber} in \`${repo}\` for review comments and:`,
            `1. Fix all comments you can address with medium or high confidence`,
            `2. Push the fixes to the same branch`,
            `3. Resolve each fixed conversation via the GitHub GraphQL API`,
            `4. Leave low-confidence items untouched`,
          ].join("\n"),
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open PR" },
            url: prUrl,
          },
        ],
      },
    ],
  };
}

function sendSlack(message) {
  const body = JSON.stringify(message);
  const url = new URL(SLACK_WEBHOOK_URL);
  const lib = url.protocol === "https:" ? https : http;
  const options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  };

  return new Promise((resolve, reject) => {
    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Enqueue a Cloud Tasks task to call /pr-check-remind in 5 minutes
async function enqueueDelayedPrCheck(prNumber, repo, prUrl, prTitle) {
  if (!CLOUD_TASKS_PROJECT || !SERVICE_URL) {
    console.warn("Cloud Tasks not configured — skipping 5-min reminder (set CLOUD_TASKS_PROJECT and SERVICE_URL)");
    return;
  }

  const scheduleTime = new Date(Date.now() + 5 * 60 * 1000);
  const body = JSON.stringify({ prNumber, repo, prUrl, prTitle });

  // Use the Cloud Tasks REST API with Application Default Credentials
  const { GoogleAuth } = require("google-auth-library");
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await auth.getClient();
  const token = (await client.getAccessToken()).token;

  const taskPayload = {
    task: {
      scheduleTime: { seconds: Math.floor(scheduleTime.getTime() / 1000) },
      httpRequest: {
        httpMethod: "POST",
        url: `${SERVICE_URL}/pr-check-remind`,
        headers: { "Content-Type": "application/json" },
        body: Buffer.from(body).toString("base64"),
        oidcToken: { serviceAccountEmail: `cloud-tasks-invoker@${CLOUD_TASKS_PROJECT}.iam.gserviceaccount.com` },
      },
    },
  };

  const queuePath = `projects/${CLOUD_TASKS_PROJECT}/locations/${CLOUD_TASKS_LOCATION}/queues/${CLOUD_TASKS_QUEUE}`;
  const apiUrl = `https://cloudtasks.googleapis.com/v2/${queuePath}/tasks`;

  const taskBody = JSON.stringify(taskPayload);
  const taskReq = new Promise((resolve, reject) => {
    const opts = {
      hostname: "cloudtasks.googleapis.com",
      path: `/v2/${queuePath}/tasks`,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(taskBody),
      },
    };
    const req = https.request(opts, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.on("error", reject);
    req.write(taskBody);
    req.end();
  });

  const result = await taskReq;
  console.log(`Cloud Tasks enqueue result: ${result.status}`);
  return result;
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    res.end("OK");
    return;
  }

  // Handle the delayed PR check callback from Cloud Tasks
  if (req.method === "POST" && req.url === "/pr-check-remind") {
    let rawBody = "";
    req.on("data", c => rawBody += c);
    req.on("end", async () => {
      try {
        const { prNumber, repo, prUrl, prTitle } = JSON.parse(rawBody);
        const message = buildPrCheckMessage(prNumber, repo, prUrl, prTitle);
        await sendSlack(message);
        console.log(`PR check reminder sent for PR #${prNumber} in ${repo}`);
        res.writeHead(200);
        res.end("OK");
      } catch (err) {
        console.error("Failed to send PR check reminder:", err);
        res.writeHead(500);
        res.end("Internal server error");
      }
    });
    return;
  }

  if (req.method !== "POST" || req.url !== "/webhook") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  let rawBody = "";
  req.on("data", (chunk) => (rawBody += chunk));
  req.on("end", async () => {
    const sig = req.headers["x-hub-signature-256"];
    if (GITHUB_WEBHOOK_SECRET && !verifySignature(GITHUB_WEBHOOK_SECRET, rawBody, sig)) {
      console.warn("Invalid signature — ignoring request");
      res.writeHead(401);
      res.end("Unauthorized");
      return;
    }

    const event = req.headers["x-github-event"];
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      res.writeHead(400);
      res.end("Bad request");
      return;
    }

    console.log(`Received event: ${event} / action: ${payload.action}`);

    if (!isRelevant(event, payload)) {
      res.writeHead(200);
      res.end("Ignored");
      return;
    }

    try {
      const message = buildSlackMessage(event, payload);
      const result = await sendSlack(message);
      console.log(`Slack notified: ${result.status}`);

      // For new PRs: enqueue a 5-min delayed check
      if (event === "pull_request" && payload.action === "opened") {
        const pr = payload.pull_request;
        await enqueueDelayedPrCheck(
          pr.number,
          payload.repository?.full_name,
          pr.html_url,
          pr.title
        ).catch(err => console.error("Failed to enqueue delayed PR check:", err));
      }

      res.writeHead(200);
      res.end("OK");
    } catch (err) {
      console.error("Failed to notify Slack:", err);
      res.writeHead(500);
      res.end("Internal server error");
    }
  });
});

server.listen(PORT, () => {
  console.log(`github-slack-notifier listening on port ${PORT}`);
  console.log(`Watching for mentions of: @${WATCHED_USER}`);
});
