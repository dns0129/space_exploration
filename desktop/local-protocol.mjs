import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

export const GAME_URL = "voyager://game/index.html?mode=flight";
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "font-src 'self'", "connect-src 'self'",
  "media-src 'self' data: blob:", "worker-src 'none'", "object-src 'none'",
  "base-uri 'none'", "form-action 'none'", "frame-src 'none'", "frame-ancestors 'none'",
].join("; ");

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"], [".json", "application/json; charset=utf-8"],
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".webp", "image/webp"], [".svg", "image/svg+xml"], [".ico", "image/x-icon"],
  [".woff", "font/woff"], [".woff2", "font/woff2"], [".ttf", "font/ttf"],
]);

function denied(message = "无法访问此资源。") {
  return Object.assign(new Error(message), { status: 403 });
}

export function isGameDocumentURL(rawURL) {
  try {
    const url = new URL(rawURL);
    return url.protocol === "voyager:" && url.host === "game" && !url.username && !url.password
      && url.pathname === "/index.html";
  } catch { return false; }
}

export function isTrustedGameSender(event, webContents) {
  return !!webContents && !webContents.isDestroyed()
    && event.sender === webContents && event.senderFrame === webContents.mainFrame
    && isGameDocumentURL(event.senderFrame?.url);
}

export function parseCloseResult(value) {
  if (value === undefined) return { saved: true };
  if (!value || typeof value !== "object" || typeof value.saved !== "boolean"
    || (value.message !== undefined && (typeof value.message !== "string" || value.message.length > 300)))
    throw new Error("退出确认格式无效。");
  return { saved: value.saved, ...(value.message ? { message: value.message } : {}) };
}

/** A native launch option supports portable/test data; it is never accepted over IPC. */
export function parseUserDataDirectory(arguments_, defaultDirectory) {
  const options = arguments_.filter((argument) => argument.startsWith("--voyager-user-data="));
  if (options.length === 0) return defaultDirectory;
  const directory = options[0].slice("--voyager-user-data=".length);
  if (options.length !== 1 || !directory || !isAbsolute(directory) || /[\u0000-\u001f\u007f]/.test(directory))
    throw new Error("存档目录参数必须是单一、非空的绝对路径。");
  return resolve(directory);
}

/** Reject path tricks before URL parsing can normalize away traversal segments. */
export function resourcePath(rawURL) {
  const matched = /^voyager:\/\/game(\/[^?#]*)?(?:\?[^#]*)?(?:#.*)?$/.exec(rawURL);
  if (!matched) throw denied();
  let pathname;
  try { pathname = decodeURIComponent(matched[1] || "/"); } catch { throw denied(); }
  if (/[\\\u0000-\u001f\u007f:%]/.test(pathname)) throw denied();
  if (pathname === "/") return "index.html";
  const parts = pathname.slice(1).split("/");
  if (parts.some((part) => !part || part.startsWith("."))) throw denied();
  return parts.join("/");
}

export async function resolveResource(root, rawURL) {
  const local = resourcePath(rawURL);
  const mime = mimeTypes.get(extname(local).toLowerCase());
  if (!mime) throw denied();
  const actualRoot = await realpath(root);
  const actualFile = await realpath(resolve(actualRoot, local));
  const inside = relative(actualRoot, actualFile);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw denied();
  if (!(await stat(actualFile)).isFile()) throw denied();
  return { path: actualFile, mime };
}

export function createLocalProtocol(root) {
  return async (request) => {
    const headers = {
      "Content-Security-Policy": CONTENT_SECURITY_POLICY,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    };
    if (!["GET", "HEAD"].includes(request.method || "GET"))
      return new Response("此资源仅支持读取。", { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
    try {
      if (request.initiatorOrigin && request.initiatorOrigin !== "voyager://game") throw denied();
      const resource = await resolveResource(root, request.url);
      const bytes = await readFile(resource.path);
      return new Response(request.method === "HEAD" ? null : bytes, {
        headers: { ...headers, "Content-Type": resource.mime, "Content-Length": String(bytes.length) },
      });
    } catch (error) {
      return new Response("无法访问此资源。", {
        status: ["ENOENT", "ENOTDIR"].includes(error.code) ? 404 : error.status || 500,
        headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  };
}
