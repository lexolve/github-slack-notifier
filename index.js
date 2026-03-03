const http = require("http");
const https = require("https");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const WATCHED_USER = process.env.WATCHED_GITHUB_USER || "openclaw";

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
    action = `opened a new PR in \`${repo}\``;

  // For new PRs: include a special marker so the AI agent knows to schedule a local reminder
  const isNewPR = event === "pull_request" && payload.action === "opened";
  const prNumber = pr?.number;
  const footerText = isNewPR
    ? `\n_🤖 PR_REVIEW_CHECK pr=${prNumber} repo=${repo} url=${url}_`
    : null;

  return {
    text: `GitHub notification for @${WATCHED_USER}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*<${url}|${title}>*\n*${sender}* ${action}${footerText || ""}`,
        },
      },
      snippet && !isNewPR
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

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    res.end("OK");
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
