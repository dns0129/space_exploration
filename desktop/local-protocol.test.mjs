import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CONTENT_SECURITY_POLICY, createLocalProtocol, isGameDocumentURL, isTrustedGameSender, parseCloseResult, parseUserDataDirectory, resourcePath, resolveResource } from "./local-protocol.mjs";

async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), "voyager-desktop-protocol-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const root = join(folder, "game");
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), "<!doctype html><title>星际探索</title>");
  await writeFile(join(root, "assets/main.js"), "export const game = true;");
  await writeFile(join(root, "assets/main.css"), "body { color: white; }");
  return { folder, root, handler: createLocalProtocol(root) };
}

test("the standard local protocol serves HTML, JavaScript and styles with CSP and correct MIME", async (t) => {
  const { root, handler } = await fixture(t);
  for (const [path, type] of [["/index.html?mode=flight", "text/html"], ["/assets/main.js", "text/javascript"], ["/assets/main.css", "text/css"]]) {
    const response = await handler({ url: `voyager://game${path}`, method: "GET", initiatorOrigin: "voyager://game" });
    assert.equal(response.status, 200);
    assert(response.headers.get("content-type").startsWith(type));
    assert.equal(response.headers.get("content-security-policy"), CONTENT_SECURITY_POLICY);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert(await response.text());
  }
  assert.equal((await resolveResource(root, "voyager://game/")).path, await realpath(join(root, "index.html")));
  const head = await handler({ url: "voyager://game/index.html", method: "HEAD" });
  assert.equal(await head.text(), "");
  assert(Number(head.headers.get("content-length")) > 0);
});

test("resource URLs reject remote hosts, traversal, encoded escapes and unsupported files", async (t) => {
  const { handler } = await fixture(t);
  for (const path of [
    "https://game/index.html", "voyager://other/index.html", "voyager://user@game/index.html", "voyager://game:80/index.html",
    "voyager://game/../index.html", "voyager://game/assets/../../secret.json", "voyager://game/%2e%2e/index.html",
    "voyager://game/%252e%252e/index.html", "voyager://game/assets%5csecret.json", "voyager://game/%00index.html",
    "voyager://game/.env", "voyager://game/%XX", "voyager://game//index.html",
  ]) {
    assert.throws(() => resourcePath(path), /无法访问/);
    assert.equal((await handler({ url: path, method: "GET" })).status, 403);
  }
  assert.equal((await handler({ url: "voyager://game/unknown.exe", method: "GET" })).status, 403);
  assert.equal((await handler({ url: "voyager://game/absent.js", method: "GET" })).status, 404);
  assert.equal((await handler({ url: "voyager://game/index.html", method: "POST" })).status, 405);
  assert.equal((await handler({ url: "voyager://game/index.html", method: "GET", initiatorOrigin: "https://untrusted.example" })).status, 403);
});

test("symlinks cannot expose files outside the packaged resource directory", async (t) => {
  const { folder, root, handler } = await fixture(t);
  const secret = join(folder, "secret.json");
  await writeFile(secret, JSON.stringify({ secret: true }));
  try { await symlink(secret, join(root, "assets/escape.json"), "file"); }
  catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) {
      t.skip("Windows lacks permission to create file symlinks; enable Developer Mode or use an elevated test runner.");
      return;
    }
    throw error;
  }
  assert.equal((await handler({ url: "voyager://game/assets/escape.json", method: "GET" })).status, 403);
});

test("only the expected local main frame is trusted for save and close IPC", () => {
  const frame = { url: "voyager://game/index.html?mode=flight" };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  assert(isTrustedGameSender({ sender: contents, senderFrame: frame }, contents));
  assert.equal(isTrustedGameSender({ sender: contents, senderFrame: { url: frame.url } }, contents), false);
  assert.equal(isTrustedGameSender({ sender: {}, senderFrame: frame }, contents), false);
  frame.url = "https://untrusted.example/index.html";
  assert.equal(isTrustedGameSender({ sender: contents, senderFrame: frame }, contents), false);
  assert.equal(isGameDocumentURL("voyager://game/assets/main.js"), false);
  assert.equal(isGameDocumentURL("voyager://game:80/index.html"), false);
});

test("close acknowledgements contain only a boolean outcome and bounded display text", () => {
  assert.deepEqual(parseCloseResult(), { saved: true });
  assert.deepEqual(parseCloseResult({ saved: false, message: "磁盘空间不足", extra: "discarded" }), { saved: false, message: "磁盘空间不足" });
  for (const value of [null, false, {}, { saved: "yes" }, { saved: false, message: 2 }, { saved: false, message: "x".repeat(301) }])
    assert.throws(() => parseCloseResult(value), /无效/);
});

test("portable launch data directories require one explicit absolute native path", () => {
  const defaultDirectory = join(tmpdir(), "default-voyager-data");
  const isolatedDirectory = join(tmpdir(), "isolated-voyager");
  assert.equal(parseUserDataDirectory(["app"], defaultDirectory), defaultDirectory);
  assert.equal(parseUserDataDirectory(["app", `--voyager-user-data=${isolatedDirectory}`], defaultDirectory), resolve(isolatedDirectory));
  for (const options of [["--voyager-user-data="], ["--voyager-user-data=relative"],
    [`--voyager-user-data=${join(tmpdir(), "a\u0000b")}`],
    [`--voyager-user-data=${join(tmpdir(), "first")}`, `--voyager-user-data=${join(tmpdir(), "second")}`]])
    assert.throws(() => parseUserDataDirectory(options, defaultDirectory), /绝对路径/);
});
