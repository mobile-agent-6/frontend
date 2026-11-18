const { randomUUID } = require("node:crypto");
function speechFiles() {
  const entries = new Map(), state = { deleted: [], failDelete: false, noopDelete: false, failWrite: false };
  const join = parts => parts.map(p => typeof p === "string" ? p.replace(/\/$/, "") : p.uri).join("/");
  class File {
    constructor(...parts) { this.uri = join(parts); }
    get name() { return this.uri.split("/").at(-1); }
    get exists() { return entries.has(this.uri); }
    get size() { return entries.get(this.uri)?.length ?? 0; }
    create() { if (this.exists) throw Error("exists"); entries.set(this.uri, new Uint8Array()); }
    async write(bytes) { if (state.writeGate) await state.writeGate; if (state.failWrite) throw Error("write"); if (!state.noopWrite) entries.set(this.uri, new Uint8Array(bytes)); }
    delete() { state.deleted.push(this.uri); if (state.failDelete) throw Error("delete"); if (!state.noopDelete) entries.delete(this.uri); }
  }
  class Directory {
    constructor(...parts) { this.uri = join(parts); }
    get exists() { return true; }
    create() {}
    list() { const found = [...entries.keys()].filter(p => p.startsWith(this.uri + "/")).map(p => new File(p)); state.onList?.(); return found; }
  }
  return { entries, state, fs: { File, Directory, Paths: { cache: new Directory("file:///cache") } }, crypto: { randomUUID: () => state.uuid ?? randomUUID() } };
}
function speechWav({ rate = 22050, channels = 1, bits = 16, frames = 100, ancillary = 0, extensible = false } = {}) {
  const fmt = extensible ? 40 : 16, extra = ancillary ? 8 + ancillary + ancillary % 2 : 0;
  const dataSize = frames * channels * bits / 8, b = new Uint8Array(12 + 8 + fmt + extra + 8 + dataSize + dataSize % 2), v = new DataView(b.buffer);
  const tag = (offset, text) => [...text].forEach((c, i) => b[offset + i] = c.charCodeAt(0));
  tag(0, "RIFF"); v.setUint32(4, b.length - 8, true); tag(8, "WAVE"); tag(12, "fmt "); v.setUint32(16, fmt, true);
  v.setUint16(20, extensible ? 65534 : 1, true); v.setUint16(22, channels, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * bits / 8, true); v.setUint16(32, channels * bits / 8, true); v.setUint16(34, bits, true);
  if (extensible) { v.setUint16(36, 22, true); v.setUint16(38, bits, true); b.set([1,0,0,0,0,0,16,0,128,0,0,170,0,56,155,113], 44); }
  let at = 20 + fmt;
  if (ancillary) { tag(at, "JUNK"); v.setUint32(at + 4, ancillary, true); at += extra; }
  tag(at, "data"); v.setUint32(at + 4, dataSize, true); return b;
}
module.exports = { speechFiles, speechWav };
