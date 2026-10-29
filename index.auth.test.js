const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
const secret = "synthetic-webhook-secret";

function loadEntrypoint(signingSecret, notifications = []) {
  let handler;
  vm.runInNewContext(source, {
    Buffer,
    URL,
    require(name) {
      if (name === "http") return {
        createServer(callback) {
          handler = callback;
          return { listen() {} };
        },
        request(options, callback) {
          assert.equal(options.hostname, "slack.invalid");
          let body = "";
          return {
            on() {},
            write(chunk) { body += chunk; },
            end() {
              notifications.push(JSON.parse(body));
              const response = new EventEmitter();
              response.statusCode = 200;
              callback(response);
              response.emit("end");
            },
          };
        },
      };
      if (name === "https") return { request() { throw new Error("External HTTP is forbidden in this fixture"); } };
      return require(name);
    },
    process: {
      env: {
        SLACK_WEBHOOK_URL: "http://slack.invalid/webhook",
        GITHUB_WEBHOOK_SECRET: signingSecret,
        WATCHED_GITHUB_USER: "synthetic-user",
      },
      exit(code) { throw Object.assign(new Error("Startup refused"), { exitCode: code }); },
    },
    console: { log() {}, warn() {}, error() {} },
  });
  return handler;
}

for (const [label, value] of [["missing", undefined], ["empty", ""], ["whitespace-only", " \t "]]) {
  test(`refuses startup with a ${label} signing secret`, () => {
    assert.throws(() => loadEntrypoint(value), (error) => error.exitCode === 1);
  });
}

test("HTTP authentication denies forged notifications and preserves signed delivery", async (t) => {
  const notifications = [];
  const server = http.createServer(loadEntrypoint(secret, notifications));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const body = JSON.stringify({
    action: "created",
    comment: { body: "@synthetic-user please review", html_url: "https://github.invalid/comment/1" },
    issue: { title: "Synthetic issue", html_url: "https://github.invalid/issues/1" },
    repository: { full_name: "synthetic/repo" },
    sender: { login: "synthetic-sender" },
  });
  const sign = (value) => `sha256=${crypto.createHmac("sha256", value).update(body).digest("hex")}`;
  const request = (method, pathname, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request(`${url}${pathname}`, { method, headers }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, text }));
    });
    req.on("error", reject);
    if (method === "POST") req.write(body);
    req.end();
  });
  const post = (signature, event = "issue_comment") => request("POST", "/webhook", {
    "x-github-event": event,
    ...(signature === undefined ? {} : { "x-hub-signature-256": signature }),
  });

  for (const [label, signature] of [["missing", undefined], ["malformed", "sha256=invalid"], ["wrong-key", sign("another-synthetic-secret")]]) {
    await t.test(`rejects a ${label} signature before notification`, async () => {
      const response = await post(signature);
      assert.equal(response.status, 401);
      assert.equal(response.text, "Unauthorized");
      assert.equal(notifications.length, 0);
    });
  }
  await t.test("a valid signature preserves the existing notification", async () => {
    const previousCount = notifications.length;
    const response = await post(sign(secret));
    assert.equal(response.status, 200);
    assert.equal(response.text, "OK");
    assert.equal(notifications.length, previousCount + 1);
    assert.equal(notifications.at(-1).text, "GitHub: @synthetic-user was mentioned");
    assert.match(notifications.at(-1).blocks[0].text.text, /synthetic-sender.*synthetic\/repo/s);
  });
  await t.test("preserves signed UTF-8 bytes across request data chunks", async () => {
    const payload = Buffer.from(body.replace("please review", "blåbær 😀"));
    const split = payload.indexOf(Buffer.from("😀")) + 1;
    const previousCount = notifications.length;
    const incoming = Object.assign(new EventEmitter(), {
      method: "POST", url: "/webhook",
      headers: {
        "x-github-event": "issue_comment",
        "x-hub-signature-256": `sha256=${crypto.createHmac("sha256", secret).update(payload).digest("hex")}`,
      },
    });
    const response = await new Promise((resolve) => {
      let status;
      loadEntrypoint(secret, notifications)(incoming, {
        writeHead(code) { status = code; },
        end(text) { resolve({ status, text }); },
      });
      incoming.emit("data", payload.subarray(0, split));
      incoming.emit("data", payload.subarray(split));
      incoming.emit("end");
    });
    assert.equal(response.status, 200);
    assert.equal(response.text, "OK");
    assert.equal(notifications.length, previousCount + 1);
    assert.match(notifications.at(-1).blocks[1].text.text, /blåbær 😀/u);
  });
  await t.test("an irrelevant signed event is ignored and health remains public", async () => {
    const previousCount = notifications.length;
    const response = await post(sign(secret), "ping");
    assert.equal(response.status, 200);
    assert.equal(response.text, "Ignored");
    assert.equal(notifications.length, previousCount);
    const health = await request("GET", "/health");
    assert.equal(health.status, 200);
    assert.equal(health.text, "OK");
  });
});
