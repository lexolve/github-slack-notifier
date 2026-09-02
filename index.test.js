const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const {
  buildOpenClawRequest,
  classifyOpenClawEvent,
  createServer,
  handleWebhook,
  loadConfig,
  normalizeOpenClawEvent,
  resolveOpenClawHookUrl,
  sendOpenClaw,
  verifySignature,
} = require("./index");

const githubSecret = "github-secret";

function sign(body, secret = githubSecret) {
  const crypto = require("node:crypto");
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

function pullRequest(overrides = {}) {
  return {
    number: 42,
    title: "Keep tenant data isolated",
    html_url: "https://github.com/lexolve/langgraph-agent/pull/42",
    state: "open",
    draft: false,
    base: { ref: "main", sha: "base-sha" },
    head: { ref: "feature/isolation", sha: "head-sha" },
    user: { login: "rubensseva", type: "User" },
    body: "Untrusted PR body that must not be forwarded.",
    ...overrides,
  };
}

function payload(overrides = {}) {
  return {
    action: "synchronize",
    before: "previous-head-sha",
    after: "head-sha",
    repository: { full_name: "lexolve/langgraph-agent" },
    sender: { login: "rubensseva", type: "User" },
    pull_request: pullRequest(),
    ...overrides,
  };
}

function config(overrides = {}) {
  return {
    port: 8080,
    slackWebhookUrl: "https://hooks.slack.test/services/test",
    githubWebhookSecret: githubSecret,
    watchedUser: "ken-lexolve",
    openClawHookUrl: "https://openclaw.example/hooks/agent",
    openClawHookToken: "hook-secret",
    openClawAgentId: "main",
    openClawObserverMode: "observe",
    openClawHookTimeoutMs: 10_000,
    ...overrides,
  };
}

test("verifySignature accepts the matching GitHub HMAC and rejects another signature", () => {
  const body = JSON.stringify(payload());
  assert.equal(verifySignature(githubSecret, body, sign(body)), true);
  assert.equal(verifySignature(githubSecret, body, "sha256=wrong"), false);
});

test("loadConfig requires complete and signed OpenClaw hook configuration", () => {
  assert.throws(
    () =>
      loadConfig({
        SLACK_WEBHOOK_URL: "https://hooks.slack.test/test",
        OPENCLAW_HOOK_URL: "https://openclaw.example/hooks",
      }),
    /OPENCLAW_HOOK_URL and OPENCLAW_HOOK_TOKEN must be configured together/
  );

  assert.throws(
    () =>
      loadConfig({
        SLACK_WEBHOOK_URL: "https://hooks.slack.test/test",
        OPENCLAW_HOOK_URL: "https://openclaw.example/hooks",
        OPENCLAW_HOOK_TOKEN: "hook-secret",
      }),
    /GITHUB_WEBHOOK_SECRET is required when OpenClaw hook delivery is enabled/
  );

  assert.throws(
    () =>
      loadConfig({
        SLACK_WEBHOOK_URL: "https://hooks.slack.test/test",
        OPENCLAW_OBSERVER_MODE: "automerge",
      }),
    /OPENCLAW_OBSERVER_MODE must be either observe or review/
  );
});

test("classifyOpenClawEvent detects a non-draft PR head change", () => {
  assert.deepEqual(
    classifyOpenClawEvent("pull_request", payload(), "ken-lexolve"),
    { kind: "pr_head_changed" }
  );
});

test("classifyOpenClawEvent ignores draft head changes and Ken's own events", () => {
  assert.equal(
    classifyOpenClawEvent(
      "pull_request",
      payload({ pull_request: pullRequest({ draft: true }) }),
      "ken-lexolve"
    ),
    null
  );
  assert.equal(
    classifyOpenClawEvent(
      "pull_request",
      payload({ sender: { login: "ken-lexolve", type: "User" } }),
      "ken-lexolve"
    ),
    null
  );
});

test("classifyOpenClawEvent detects a submitted review", () => {
  assert.deepEqual(
    classifyOpenClawEvent(
      "pull_request_review",
      payload({
        action: "submitted",
        review: {
          id: 222,
          state: "commented",
          body: "Untrusted review text that must not be forwarded.",
          user: { login: "coderabbitai", type: "Bot" },
        },
      }),
      "ken-lexolve"
    ),
    { kind: "pr_review_submitted" }
  );
});

test("classifyOpenClawEvent detects thread replies but coalesces initial comments into review submission", () => {
  const initialComment = payload({
    action: "created",
    comment: {
      id: 123,
      body: "Initial comment",
      user: { login: "coderabbitai", type: "Bot" },
    },
  });
  assert.equal(
    classifyOpenClawEvent(
      "pull_request_review_comment",
      initialComment,
      "ken-lexolve"
    ),
    null
  );

  assert.deepEqual(
    classifyOpenClawEvent(
      "pull_request_review_comment",
      payload({
        action: "created",
        comment: {
          id: 124,
          in_reply_to_id: 123,
          body: "Thread reply",
          user: { login: "rubensseva", type: "User" },
        },
      }),
      "ken-lexolve"
    ),
    { kind: "pr_review_thread_replied" }
  );
});

test("normalizeOpenClawEvent includes identifiers but excludes PR and comment bodies", () => {
  const source = payload({
    action: "created",
    comment: {
      id: 123,
      html_url: "https://github.com/lexolve/langgraph-agent/pull/42#discussion_r123",
      path: "src/auth.ts",
      line: 18,
      side: "RIGHT",
      body: "Do not forward this body.",
      user: { login: "coderabbitai", type: "Bot" },
    },
  });
  source.review = {
    id: 222,
    html_url: "https://github.com/lexolve/langgraph-agent/pull/42#pullrequestreview-222",
    state: "commented",
    commit_id: "head-sha",
    body: "Do not forward this review body.",
    user: { login: "coderabbitai", type: "Bot" },
  };
  const event = normalizeOpenClawEvent(
    "pull_request_review_comment",
    source,
    "delivery-123",
    "pr_review_thread_replied"
  );

  assert.equal(event.eventId, "delivery-123");
  assert.equal(event.kind, "pr_review_thread_replied");
  assert.equal(event.repository, "lexolve/langgraph-agent");
  assert.equal(event.change.beforeSha, "previous-head-sha");
  assert.equal(event.change.afterSha, "head-sha");
  assert.equal(event.pullRequest.headSha, "head-sha");
  assert.equal(event.review.id, 222);
  assert.equal(event.review.state, "commented");
  assert.equal(event.comment.id, 123);
  assert.equal(event.comment.path, "src/auth.ts");
  assert.equal(JSON.stringify(event).includes("Do not forward this review body"), false);
  assert.equal(JSON.stringify(event).includes("Do not forward this body"), false);
  assert.equal(JSON.stringify(event).includes("Untrusted PR body"), false);
});

test("resolveOpenClawHookUrl accepts a hook base or full agent endpoint", () => {
  assert.equal(
    resolveOpenClawHookUrl("https://openclaw.example/hooks"),
    "https://openclaw.example/hooks/agent"
  );
  assert.equal(
    resolveOpenClawHookUrl("https://openclaw.example/hooks/agent"),
    "https://openclaw.example/hooks/agent"
  );
  assert.equal(
    resolveOpenClawHookUrl("http://127.0.0.1:18789/hooks"),
    "http://127.0.0.1:18789/hooks/agent"
  );
  assert.equal(
    resolveOpenClawHookUrl("http://[::1]:18789/hooks"),
    "http://[::1]:18789/hooks/agent"
  );
  assert.throws(
    () => resolveOpenClawHookUrl("http://openclaw.example/hooks"),
    /must use HTTPS unless it targets loopback/
  );
});

test("buildOpenClawRequest creates a silent, idempotent agent turn", () => {
  const event = normalizeOpenClawEvent(
    "pull_request",
    payload(),
    "delivery-123",
    "pr_head_changed"
  );
  const request = buildOpenClawRequest(event, config());

  assert.equal(request.agentId, "main");
  assert.equal(request.sessionMode, "isolated");
  assert.equal(request.deliver, false);
  assert.equal(request.idempotencyKey, "github:delivery-123");
  assert.match(request.message, /Fetch authoritative current state from GitHub/);
  assert.match(request.message, /Observe mode is enabled/);
  assert.match(request.message, /Do not write to GitHub, Linear, Slack/);
  assert.match(request.message, /pr_head_changed/);
});

test("handleWebhook sends a head-change event to OpenClaw without Slack noise", async () => {
  const rawBody = JSON.stringify(payload());
  const slackMessages = [];
  const hookRequests = [];

  const result = await handleWebhook({
    headers: {
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-123",
      "x-hub-signature-256": sign(rawBody),
    },
    rawBody,
    config: config(),
    sendSlackFn: async (message) => slackMessages.push(message),
    sendOpenClawFn: async (request) => hookRequests.push(request),
    logger: { log() {}, warn() {}, error() {} },
  });

  assert.deepEqual(result, { status: 200, body: "OK" });
  assert.equal(slackMessages.length, 0);
  assert.equal(hookRequests.length, 1);
  assert.equal(hookRequests[0].idempotencyKey, "github:delivery-123");
});

test("handleWebhook preserves existing Slack mention behavior", async () => {
  const source = payload({
    action: "created",
    comment: {
      id: 456,
      html_url: "https://github.com/lexolve/langgraph-agent/pull/42#issuecomment-456",
      body: "@ken-lexolve please review",
      user: { login: "rubensseva", type: "User" },
    },
    issue: {
      number: 42,
      title: "Keep tenant data isolated",
      html_url: "https://github.com/lexolve/langgraph-agent/pull/42",
    },
  });
  delete source.pull_request;
  const rawBody = JSON.stringify(source);
  const slackMessages = [];
  const hookRequests = [];

  const result = await handleWebhook({
    headers: {
      "x-github-event": "issue_comment",
      "x-github-delivery": "delivery-456",
      "x-hub-signature-256": sign(rawBody),
    },
    rawBody,
    config: config(),
    sendSlackFn: async (message) => slackMessages.push(message),
    sendOpenClawFn: async (request) => hookRequests.push(request),
    logger: { log() {}, warn() {}, error() {} },
  });

  assert.deepEqual(result, { status: 200, body: "OK" });
  assert.equal(slackMessages.length, 1);
  assert.equal(hookRequests.length, 0);
});

test("handleWebhook still delivers an overlapping observer event when Slack fails", async () => {
  const source = payload({
    action: "submitted",
    review: {
      id: 789,
      html_url: "https://github.com/lexolve/langgraph-agent/pull/42#pullrequestreview-789",
      state: "commented",
      body: "@ken-lexolve please check this review",
      commit_id: "head-sha",
      user: { login: "coderabbitai", type: "Bot" },
    },
  });
  const rawBody = JSON.stringify(source);
  const hookRequests = [];

  const result = await handleWebhook({
    headers: {
      "x-github-event": "pull_request_review",
      "x-github-delivery": "delivery-overlap",
      "x-hub-signature-256": sign(rawBody),
    },
    rawBody,
    config: config(),
    sendSlackFn: async () => {
      throw new Error("Slack unavailable");
    },
    sendOpenClawFn: async (request) => hookRequests.push(request),
    logger: { log() {}, warn() {}, error() {} },
  });

  assert.deepEqual(result, { status: 500, body: "Internal server error" });
  assert.equal(hookRequests.length, 1);
  assert.equal(hookRequests[0].idempotencyKey, "github:delivery-overlap");
});

test("buildOpenClawRequest allows an explicit review mode without changing safety boundaries", () => {
  const event = normalizeOpenClawEvent(
    "pull_request",
    payload(),
    "delivery-review",
    "pr_head_changed"
  );
  const request = buildOpenClawRequest(
    event,
    config({ openClawObserverMode: "review" })
  );

  assert.match(request.message, /Review mode is enabled/);
  assert.match(request.message, /serious, verified, non-duplicate findings/);
  assert.match(request.message, /do not approve, merge, push, or deploy/i);
});

test("handleWebhook treats OpenClaw observer delivery as best effort", async () => {
  const rawBody = JSON.stringify(payload());
  const warnings = [];

  const result = await handleWebhook({
    headers: {
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-123",
      "x-hub-signature-256": sign(rawBody),
    },
    rawBody,
    config: config(),
    sendSlackFn: async () => {},
    sendOpenClawFn: async () => {
      throw new Error("hook unavailable");
    },
    logger: { log() {}, warn: (...args) => warnings.push(args), error() {} },
  });

  assert.deepEqual(result, { status: 200, body: "OK" });
  assert.equal(warnings.length, 1);
});

test("handleWebhook rejects an invalid GitHub signature before delivery", async () => {
  const rawBody = JSON.stringify(payload());
  let delivered = false;

  const result = await handleWebhook({
    headers: {
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-123",
      "x-hub-signature-256": "sha256=wrong",
    },
    rawBody,
    config: config(),
    sendSlackFn: async () => {
      delivered = true;
    },
    sendOpenClawFn: async () => {
      delivered = true;
    },
    logger: { log() {}, warn() {}, error() {} },
  });

  assert.deepEqual(result, { status: 401, body: "Unauthorized" });
  assert.equal(delivered, false);
});

test("sendOpenClaw uses the agent endpoint, bearer auth, and idempotency header", async (t) => {
  let received;
  const receiver = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received = {
        path: req.url,
        authorization: req.headers.authorization,
        idempotencyKey: req.headers["idempotency-key"],
        body: JSON.parse(body),
      };
      res.writeHead(200);
      res.end("accepted");
    });
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => receiver.close(resolve)));

  const address = receiver.address();
  const event = normalizeOpenClawEvent(
    "pull_request",
    payload(),
    "delivery-http",
    "pr_head_changed"
  );
  const request = buildOpenClawRequest(event, config());

  await sendOpenClaw(
    request,
    config({ openClawHookUrl: `http://127.0.0.1:${address.port}/hooks` })
  );

  assert.equal(received.path, "/hooks/agent");
  assert.equal(received.authorization, "Bearer hook-secret");
  assert.equal(received.idempotencyKey, "github:delivery-http");
  assert.equal(received.body.name, "GitHub pr_head_changed");
  assert.equal(received.body.sessionMode, "isolated");
  assert.equal(received.body.deliver, false);
});

test("createServer rejects oversized webhook payloads before processing", async (t) => {
  const server = createServer(
    config({ openClawHookUrl: undefined, openClawHookToken: undefined }),
    { log() {}, warn() {}, error() {} },
    { maxBodyBytes: 32 }
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const response = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        path: "/webhook",
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    request.on("error", reject);
    request.end("x".repeat(33));
  });

  assert.deepEqual(response, { status: 413, body: "Payload too large" });
});
