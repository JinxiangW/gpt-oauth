#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { installGlobalFetchProxy } from "./proxy.mjs";

installGlobalFetchProxy();

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE_URL = "https://auth.openai.com";
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";

const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;

const CALLBACK_PORT = 1455;

function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return join(fromEnv.trim());
  return join(homedir(), ".dsh");
}

function oauthFile() {
  return join(dshHome(), "openai-oauth.json");
}

function generatePkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function createState() {
  return randomBytes(16).toString("hex");
}

function openBrowser(url) {
  const command =
    process.platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", url] }
      : process.platform === "darwin"
        ? { file: "open", args: [url] }
        : { file: "xdg-open", args: [url] };
  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
}

function authorizationUrl(verifier, state) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", verifier);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "dsh");
  return url.toString();
}

function successHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>dsh OpenAI login</title></head>
<body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0">
<div><h1>OpenAI authentication completed</h1><p>You can close this window and return to dsh.</p></div>
</body></html>`;
}

function errorHtml(message) {
  const escaped = message.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
  return `<!doctype html><html><head><meta charset="utf-8"><title>dsh OpenAI login</title></head>
<body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0">
<div><h1>Login failed</h1><p>${escaped}</p></div>
</body></html>`;
}

function startCallbackServer(state) {
  let listening = false;
  let settled = false;
  let settleWait;
  const waitForCode = new Promise((resolve) => {
    settleWait = resolve;
  });

  const server = createServer((req, res) => {
    const send = (status, body) => {
      res.statusCode = status;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(body);
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/auth/callback") return send(404, errorHtml("Callback route not found."));
      if (url.searchParams.get("state") !== state) return send(400, errorHtml("State mismatch."));
      const code = url.searchParams.get("code");
      if (code === null || code.length === 0) return send(400, errorHtml("Missing authorization code."));
      if (!settled) {
        settled = true;
        settleWait({ code });
      }
      send(200, successHtml());
    } catch {
      send(500, errorHtml("Internal error while processing OAuth callback."));
    }
  });

  return new Promise((resolve) => {
    server.once("error", (error) => {
      if (!settled) {
        settled = true;
        settleWait({ error });
      }
      resolve({
        waitForCode,
        close: async () => {},
      });
    });
    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      listening = true;
      resolve({
        waitForCode,
        close: () =>
          new Promise((closeResolve) => {
            if (!listening) return closeResolve();
            server.close(() => closeResolve());
          }),
      });
    });
  });
}

async function readTokenResponse(response, operation) {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI token ${operation} failed (HTTP ${response.status}): ${body.slice(0, 400)}`);
  }
  const payload = await response.json();
  if (
    typeof payload?.access_token !== "string" ||
    payload.access_token.length === 0 ||
    typeof payload?.refresh_token !== "string" ||
    payload.refresh_token.length === 0 ||
    typeof payload?.expires_in !== "number" ||
    !Number.isFinite(payload.expires_in) ||
    payload.expires_in <= 0
  ) {
    throw new Error(`OpenAI token ${operation} response missing fields`);
  }
  return {
    type: "oauth",
    access: payload.access_token,
    refresh: payload.refresh_token,
    expires: Date.now() + payload.expires_in * 1000,
  };
}

async function exchangeAuthorizationCode(code, verifier, redirectUri) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });
  return readTokenResponse(response, "exchange");
}

async function browserLogin() {
  const { verifier, challenge } = generatePkce();
  const state = createState();
  const url = authorizationUrl(challenge, state);

  let controller;
  try {
    controller = await startCallbackServer(state);
  } catch {
    throw new Error(`Could not start the OAuth callback server on port ${CALLBACK_PORT}. Use: dsh-openai-login --device`);
  }

  console.log("Opening OpenAI login in your browser...\n");
  console.log(`If the browser does not open, visit:\n${url}\n`);
  openBrowser(url);

  let result;
  try {
    result = await controller.waitForCode;
  } finally {
    await controller.close();
  }
  if (result?.error !== undefined) {
    throw new Error(
      result.error.code === "EADDRINUSE"
        ? `Port ${CALLBACK_PORT} is already in use. Use: dsh-openai-login --device`
        : `OAuth callback failed: ${result.error.message}`,
    );
  }
  if (typeof result?.code !== "string" || result.code.length === 0) {
    throw new Error("OAuth callback did not provide an authorization code");
  }
  return exchangeAuthorizationCode(result.code, verifier, REDIRECT_URI);
}

async function startDeviceAuth() {
  const response = await fetch(DEVICE_USER_CODE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI device-code request failed (HTTP ${response.status}): ${body.slice(0, 400)}`);
  }
  const payload = await response.json();
  const interval = typeof payload?.interval === "string" ? Number(payload.interval.trim()) : payload?.interval;
  if (
    typeof payload?.device_auth_id !== "string" ||
    payload.device_auth_id.length === 0 ||
    typeof payload?.user_code !== "string" ||
    payload.user_code.length === 0 ||
    typeof interval !== "number" ||
    !Number.isFinite(interval) ||
    interval < 0
  ) {
    throw new Error(`Invalid OpenAI device-code response: ${JSON.stringify(payload)}`);
  }
  return {
    deviceAuthId: payload.device_auth_id,
    userCode: payload.user_code,
    intervalSeconds: interval,
  };
}

async function pollDeviceAuth(device) {
  const deadline = Date.now() + DEVICE_CODE_TIMEOUT_SECONDS * 1000;
  while (Date.now() < deadline) {
    const response = await fetch(DEVICE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_auth_id: device.deviceAuthId,
        user_code: device.userCode,
      }),
    });
    if (response.ok) {
      const payload = await response.json();
      if (
        typeof payload?.authorization_code !== "string" ||
        typeof payload?.code_verifier !== "string" ||
        payload.code_verifier.length === 0
      ) {
        throw new Error(`Invalid OpenAI device-auth token response: ${JSON.stringify(payload)}`);
      }
      return {
        authorizationCode: payload.authorization_code,
        codeVerifier: payload.code_verifier,
      };
    }
    if (response.status === 403 || response.status === 404) {
      await new Promise((resolve) => setTimeout(resolve, device.intervalSeconds * 1000));
      continue;
    }
    const body = await response.text().catch(() => "");
    let errorCode;
    try {
      const error = JSON.parse(body)?.error;
      errorCode = typeof error === "object" ? error?.code : error;
    } catch {
      errorCode = undefined;
    }
    if (errorCode === "deviceauth_authorization_pending" || errorCode === "slow_down") {
      await new Promise((resolve) => setTimeout(resolve, device.intervalSeconds * 1000));
      continue;
    }
    throw new Error(`OpenAI device auth failed (HTTP ${response.status}): ${body.slice(0, 400)}`);
  }
  throw new Error("OpenAI device-code login timed out");
}

async function deviceLogin() {
  const device = await startDeviceAuth();
  console.log(`Open a browser and enter this code: ${device.userCode}\n`);
  console.log(`Verification URL: ${DEVICE_VERIFICATION_URI}\n`);
  console.log("Waiting for approval...");
  const code = await pollDeviceAuth(device);
  return exchangeAuthorizationCode(code.authorizationCode, code.codeVerifier, DEVICE_REDIRECT_URI);
}

async function saveCredentials(credentials) {
  const path = oauthFile();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(credentials, null, 2) + "\n", { mode: 0o600 });
  return path;
}

const useDevice = process.argv.includes("--device");
const credentials = await (useDevice ? deviceLogin() : browserLogin());
const savedPath = await saveCredentials(credentials);
console.log(`\nOpenAI subscription login saved to ${savedPath}`);
console.log("Restart dsh (or start a new model request) and select OpenAI (ChatGPT) models.");
