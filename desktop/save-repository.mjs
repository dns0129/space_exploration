import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { validateFlightState } from "../shared/flight-state.mjs";

export const MAX_SAVE_BYTES = 8 * 1024;

function serializeState(value) {
  let source;
  try { source = JSON.stringify(value); } catch { throw new Error("航行存档格式无效。"); }
  if (typeof source !== "string" || Buffer.byteLength(source) > MAX_SAVE_BYTES)
    throw new Error("航行存档超过 8 KiB 限制或格式无效。");
  const safe = validateFlightState(value);
  if (!safe) throw new Error("航行存档格式无效。");
  const serialized = JSON.stringify(safe);
  if (Buffer.byteLength(serialized) > MAX_SAVE_BYTES) throw new Error("航行存档超过 8 KiB 限制。");
  return serialized;
}

/** Only the main process owns the fixed save path; renderer input never chooses files. */
export class DesktopSaveRepository {
  constructor(directory) {
    this.directory = resolve(directory);
    this.file = join(this.directory, "flight.json");
    this.pending = Promise.resolve();
    this.lastWrite = Promise.resolve();
  }

  async read() {
    await this.pending;
    let handle;
    try {
      // Do not follow a save file replaced with a symlink to another local file.
      if ((await lstat(this.file)).isSymbolicLink()) return null;
      handle = await open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_SAVE_BYTES) return null;
      const bytes = Buffer.alloc(MAX_SAVE_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const read = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
        if (!read.bytesRead) break;
        bytesRead += read.bytesRead;
      }
      if (bytesRead > MAX_SAVE_BYTES) return null;
      try { return validateFlightState(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"))); }
      catch { return null; }
    } catch (error) {
      if (["ENOENT", "ELOOP", "EISDIR"].includes(error.code)) return null;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  write(value) {
    // Capture and validate now, before a queued write can observe a mutated object.
    let serialized;
    try { serialized = serializeState(value); } catch (error) { return Promise.reject(error); }
    const writing = this.pending.then(() => this.atomicWrite(serialized));
    this.pending = writing.then(() => {}, () => {});
    this.lastWrite = writing;
    return writing;
  }

  flush() {
    return this.lastWrite;
  }

  async atomicWrite(serialized) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.flight-${process.pid}-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.file);
    } finally {
      await handle?.close();
      await rm(temporary, { force: true });
    }
  }
}
