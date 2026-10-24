// Runs runSync against an in-memory vault and an in-memory Drive.
// Build and run: npm test
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { TFile, TFolder } from "obsidian";
import type { DriveClient, RemoteFile, RemoteTree } from "../src/drive";
import { DEFAULT_SETTINGS, GSyncSettings, parseFolderId } from "../src/settings";
import { MassDeleteError, runSync, SyncOptions, SyncState } from "../src/sync";

const FOLDER = "application/vnd.google-apps.folder";
const enc = new TextEncoder();
const dec = new TextDecoder();
const buf = (s: string) => enc.encode(s).buffer as ArrayBuffer;
const text = (b: ArrayBuffer) => dec.decode(b);
const md5 = (b: ArrayBuffer) => createHash("md5").update(Buffer.from(b)).digest("hex");

// ---- fake vault -------------------------------------------------------------
class FakeVault {
  files = new Map<string, { data: ArrayBuffer; mtime: number }>();
  folders = new Set<string>();
  trashed: string[] = [];
  configDir = ".obsidian";
  private clock = 1000;

  put(path: string, s: string) {
    this.files.set(path, { data: buf(s), mtime: ++this.clock });
  }
  read(path: string) {
    const f = this.files.get(path);
    return f ? text(f.data) : undefined;
  }
  private tfile(path: string) {
    const f = this.files.get(path)!;
    return new TFile(path, { mtime: f.mtime, size: f.data.byteLength, ctime: 0 });
  }
  getFiles() {
    return [...this.files.keys()].map((p) => this.tfile(p));
  }
  getAbstractFileByPath(path: string) {
    if (this.files.has(path)) return this.tfile(path);
    if (this.folders.has(path)) return new TFolder(path);
    return null;
  }
  async createFolder(path: string) {
    this.folders.add(path);
  }
  async readBinary(f: TFile) {
    return this.files.get(f.path)!.data;
  }
  async modifyBinary(f: TFile, data: ArrayBuffer) {
    this.files.set(f.path, { data, mtime: ++this.clock });
  }
  async createBinary(path: string, data: ArrayBuffer) {
    this.files.set(path, { data, mtime: ++this.clock });
  }
  adapter = {
    stat: async (path: string) => {
      const f = this.files.get(path);
      return f ? { mtime: f.mtime, size: f.data.byteLength } : null;
    },
  };
  app() {
    return {
      vault: this,
      fileManager: {
        trashFile: async (f: TFile) => {
          this.files.delete(f.path);
          this.trashed.push(f.path);
        },
      },
    };
  }
}

// ---- fake drive -------------------------------------------------------------
interface Node {
  id: string;
  name: string;
  mimeType: string;
  parent: string;
  data?: ArrayBuffer;
  modifiedTime: string;
  trashed: boolean;
}

class FakeDrive {
  nodes = new Map<string, Node>();
  private n = 0;
  /** Runs once, right after the sync has listed the remote tree. */
  afterList: (() => void) | null = null;

  constructor() {
    this.nodes.set("root", { id: "root", name: "My Drive", mimeType: FOLDER, parent: "", modifiedTime: "t0", trashed: false });
  }
  private meta(n: Node): RemoteFile {
    return {
      id: n.id,
      name: n.name,
      mimeType: n.mimeType,
      md5Checksum: n.data ? md5(n.data) : undefined,
      modifiedTime: n.modifiedTime,
      size: n.data ? String(n.data.byteLength) : undefined,
      trashed: n.trashed,
    };
  }
  private add(name: string, parent: string, mimeType: string, data?: ArrayBuffer) {
    const id = `id${++this.n}`;
    this.nodes.set(id, { id, name, mimeType, parent, data, modifiedTime: `t${this.n}`, trashed: false });
    return id;
  }
  private isTrashed(id: string): boolean {
    const n = this.nodes.get(id);
    if (!n) return true;
    // A parent we don't model (e.g. the hidden "Computers" root) counts as top level.
    return n.trashed || (this.nodes.has(n.parent) && this.isTrashed(n.parent));
  }
  children(id: string) {
    return [...this.nodes.values()].filter((n) => n.parent === id && !this.isTrashed(n.id));
  }
  mkdirp(path: string, parent = "root") {
    for (const name of path.split("/").filter(Boolean)) {
      parent = this.children(parent).find((c) => c.name === name && c.mimeType === FOLDER)?.id ?? this.add(name, parent, FOLDER);
    }
    return parent;
  }
  putFile(folderId: string, path: string, s: string) {
    const parts = path.split("/");
    const parent = this.mkdirp(parts.slice(0, -1).join("/"), folderId);
    const existing = this.children(parent).find((c) => c.name === parts[parts.length - 1] && c.mimeType !== FOLDER);
    if (existing) {
      existing.data = buf(s);
      existing.modifiedTime = `t${++this.n}`;
      return existing.id;
    }
    return this.add(parts[parts.length - 1], parent, "text/markdown", buf(s));
  }
  readFile(folderId: string, path: string): string | undefined {
    let cur = folderId;
    const parts = path.split("/");
    for (const p of parts.slice(0, -1)) cur = this.children(cur).find((c) => c.name === p)?.id ?? "";
    const f = this.children(cur).find((c) => c.name === parts[parts.length - 1]);
    return f?.data ? text(f.data) : undefined;
  }

  // -- DriveClient surface used by runSync --
  async ensureFolderPath(path: string) {
    let parent = "root";
    let created = false;
    for (const name of path.split("/").filter(Boolean)) {
      const found = this.children(parent).find((c) => c.name === name && c.mimeType === FOLDER);
      if (found) parent = found.id;
      else {
        parent = this.add(name, parent, FOLDER);
        created = true;
      }
    }
    return { id: parent, created };
  }
  async getFile(id: string) {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`Drive API 404: ${id}`);
    return { ...this.meta(n), trashed: this.isTrashed(id) };
  }
  async listTree(rootId: string): Promise<RemoteTree> {
    const files = new Map<string, RemoteFile>();
    const folders = new Map<string, string>([["", rootId]]);
    const walk = (id: string, prefix: string) => {
      for (const c of this.children(id)) {
        const p = prefix ? `${prefix}/${c.name}` : c.name;
        if (c.mimeType === FOLDER) {
          folders.set(p, c.id);
          walk(c.id, p);
        } else files.set(p, this.meta(c));
      }
    };
    walk(rootId, "");
    const hook = this.afterList;
    this.afterList = null;
    hook?.();
    return { files, folders, warnings: [] };
  }
  async createFolder(name: string, parent: string) {
    return this.add(name, parent, FOLDER);
  }
  async createFile(name: string, parent: string, data: ArrayBuffer) {
    return this.meta(this.nodes.get(this.add(name, parent, "text/markdown", data))!);
  }
  async updateFile(id: string, data: ArrayBuffer) {
    const n = this.nodes.get(id)!;
    n.data = data;
    n.modifiedTime = `t${++this.n}`;
    return this.meta(n);
  }
  async download(id: string) {
    return this.nodes.get(id)!.data!;
  }
  async trash(id: string) {
    this.nodes.get(id)!.trashed = true;
  }
}

// ---- helpers ----------------------------------------------------------------
function setup(over: Partial<GSyncSettings> = {}) {
  const vault = new FakeVault();
  const drive = new FakeDrive();
  const state: SyncState = {};
  const settings: GSyncSettings = { ...DEFAULT_SETTINGS, remoteFolder: "Obsidian/Test", ...over };
  const clock = { now: 1_000_000 };
  const minutes = (m: number) => (clock.now += m * 60 * 1000);
  const sync = (opts: SyncOptions = {}) =>
    runSync(vault.app() as never, drive as unknown as DriveClient, settings, state, { checkpoint: async () => {}, progress: () => {} }, { now: clock.now, ...opts });
  return { vault, drive, state, settings, sync, minutes };
}

// ---- tests ------------------------------------------------------------------
test("parseFolderId accepts IDs and Drive URLs", () => {
  assert.equal(parseFolderId("1AbC_d-9"), "1AbC_d-9");
  assert.equal(parseFolderId(" https://drive.google.com/drive/folders/1AbC_d-9?usp=sharing "), "1AbC_d-9");
  assert.equal(parseFolderId("https://drive.google.com/drive/u/0/folders/1AbC_d-9"), "1AbC_d-9");
  assert.equal(parseFolderId("https://drive.google.com/open?id=1AbC_d-9"), "1AbC_d-9");
});

test("folder ID: syncs a folder outside the configured path, both directions", async () => {
  const t = setup({ remoteFolder: "Obsidian/Unused" });
  // Like a Computers folder: its parent is not My Drive and is not reachable by path.
  const computers = t.drive.mkdirp("MyWiki", "computers-root");
  t.settings.remoteFolderId = computers;
  t.drive.putFile(computers, "notes/a.md", "remote A");
  t.vault.put("b.md", "local B");

  const r = await t.sync();
  assert.deepEqual(r.errors, []);
  assert.equal(t.vault.read("notes/a.md"), "remote A");
  assert.equal(t.drive.readFile(computers, "b.md"), "local B");
  assert.equal(t.drive.children("root").length, 0, "nothing created under My Drive");
});

test("folder ID: a trashed folder stops the sync and deletes nothing", async () => {
  const t = setup();
  const id = t.drive.mkdirp("Vault");
  t.settings.remoteFolderId = id;
  t.drive.putFile(id, "a.md", "A");
  await t.sync();
  assert.equal(t.vault.read("a.md"), "A");

  t.drive.nodes.get(id)!.trashed = true;
  await assert.rejects(t.sync(), /in the trash/);
  assert.equal(t.vault.read("a.md"), "A");
  assert.deepEqual(t.vault.trashed, []);
});

test("folder ID: rejects an ID that is not a folder", async () => {
  const t = setup();
  const id = t.drive.mkdirp("Vault");
  t.settings.remoteFolderId = t.drive.putFile(id, "a.md", "A");
  await assert.rejects(t.sync(), /not a folder/);
});

test("path: folder renamed in Drive after syncing stops instead of trashing local notes", async () => {
  const t = setup({ remoteFolder: "Obsidian/Test" });
  const id = t.drive.mkdirp("Obsidian/Test");
  for (let i = 0; i < 5; i++) t.drive.putFile(id, `n${i}.md`, `note ${i}`);
  await t.sync();
  assert.equal(t.vault.files.size, 5);

  t.drive.nodes.get(id)!.name = "Renamed";
  await assert.rejects(t.sync(), /any more/);
  assert.equal(t.vault.files.size, 5);
  assert.deepEqual(t.vault.trashed, []);
});

test("path: first sync into a new folder still works", async () => {
  const t = setup({ remoteFolder: "Obsidian/Fresh" });
  t.vault.put("a.md", "A");
  const r = await t.sync();
  assert.equal(r.uploaded, 1);
});

test("deletion limit: a mass delete in Drive pauses before deleting anything", async () => {
  const t = setup({ maxDeletesPerSync: 50 });
  const id = t.drive.mkdirp("Obsidian/Test");
  for (let i = 0; i < 60; i++) t.drive.putFile(id, `n${i}.md`, `note ${i}`);
  await t.sync();
  assert.equal(t.vault.files.size, 60);

  for (const c of t.drive.children(id)) c.trashed = true;
  const first = await t.sync(); // first sighting: only marked as pending
  assert.equal(first.pendingDeletes.length, 60);
  t.minutes(6);
  await assert.rejects(t.sync(), (e) => e instanceof MassDeleteError && e.count === 60 && e.limit === 50);
  assert.equal(t.vault.files.size, 60);

  const r = await t.sync({ allowMassDelete: true });
  assert.equal(r.deletedLocal, 60);
  assert.equal(t.vault.files.size, 0);
});

test("confirmed deletes: a file gone from Drive is removed only on a sync after the delay", async () => {
  const t = setup({ confirmDriveDeletesMinutes: 5 });
  const id = t.drive.mkdirp("Obsidian/Test");
  const fid = t.drive.putFile(id, "a.md", "A");
  t.drive.putFile(id, "b.md", "B");
  await t.sync();

  t.drive.nodes.get(fid)!.trashed = true;
  const r1 = await t.sync();
  assert.deepEqual(r1.pendingDeletes, ["a.md"]);
  assert.equal(r1.deletedLocal, 0);
  assert.equal(t.vault.read("a.md"), "A");

  t.minutes(2);
  const r2 = await t.sync(); // still too soon
  assert.deepEqual(r2.pendingDeletes, ["a.md"]);
  assert.equal(t.vault.read("a.md"), "A");

  t.minutes(4);
  const r3 = await t.sync();
  assert.equal(r3.deletedLocal, 1);
  assert.equal(t.vault.read("a.md"), undefined);
  assert.equal(t.vault.read("b.md"), "B");
});

test("confirmed deletes: a file that comes back (e.g. folder restore still in progress) is kept", async () => {
  const t = setup({ confirmDriveDeletesMinutes: 5 });
  const id = t.drive.mkdirp("Obsidian/Test");
  const fid = t.drive.putFile(id, "sub/a.md", "A");
  await t.sync();

  t.drive.nodes.get(fid)!.trashed = true; // briefly hidden
  assert.deepEqual((await t.sync()).pendingDeletes, ["sub/a.md"]);
  t.drive.nodes.get(fid)!.trashed = false; // shows up again
  t.minutes(10);
  const r = await t.sync();
  assert.deepEqual(r.pendingDeletes, []);
  assert.equal(r.deletedLocal, 0);
  assert.equal(t.vault.read("sub/a.md"), "A");
  assert.equal(t.state["sub/a.md"].missingSince, undefined);

  // Disappearing again later starts a fresh wait instead of reusing the old timestamp.
  t.drive.nodes.get(fid)!.trashed = true;
  t.minutes(30);
  assert.deepEqual((await t.sync()).pendingDeletes, ["sub/a.md"]);
  assert.equal(t.vault.read("sub/a.md"), "A");
});

test("confirmed deletes: 0 minutes removes on the first sync, local deletions are never delayed", async () => {
  const t = setup({ confirmDriveDeletesMinutes: 0 });
  const id = t.drive.mkdirp("Obsidian/Test");
  const fid = t.drive.putFile(id, "a.md", "A");
  t.drive.putFile(id, "b.md", "B");
  await t.sync();
  t.drive.nodes.get(fid)!.trashed = true;
  assert.equal((await t.sync()).deletedLocal, 1);

  const t2 = setup({ confirmDriveDeletesMinutes: 5 });
  const id2 = t2.drive.mkdirp("Obsidian/Test");
  t2.drive.putFile(id2, "c.md", "C");
  await t2.sync();
  t2.vault.files.delete("c.md");
  const r = await t2.sync();
  assert.equal(r.deletedRemote, 1);
  assert.equal(t2.drive.readFile(id2, "c.md"), undefined);
});

test("deletion limit: deletions under the limit go through", async () => {
  const t = setup({ maxDeletesPerSync: 50 });
  const id = t.drive.mkdirp("Obsidian/Test");
  for (let i = 0; i < 10; i++) t.drive.putFile(id, `n${i}.md`, `note ${i}`);
  await t.sync();
  t.vault.files.delete("n0.md");
  t.vault.files.delete("n1.md");
  const r = await t.sync();
  assert.equal(r.deletedRemote, 2);
  assert.equal(t.drive.readFile(id, "n0.md"), undefined);
});

test("pre-write check: a Drive edit made during the sync is not overwritten", async () => {
  const t = setup();
  const id = t.drive.mkdirp("Obsidian/Test");
  const fid = t.drive.putFile(id, "a.md", "v1");
  await t.sync();

  t.vault.put("a.md", "phone edit");
  t.drive.afterList = () => void t.drive.updateFile(fid, buf("agent edit"));
  const r = await t.sync();
  assert.deepEqual(r.deferred, ["a.md"]);
  assert.equal(t.drive.readFile(id, "a.md"), "agent edit");
  assert.equal(t.vault.read("a.md"), "phone edit");

  // Next sync sees both sides changed and keeps both.
  const r2 = await t.sync();
  assert.deepEqual(r2.conflicts, ["a.md"]);
  assert.equal(t.vault.read("a.md"), "phone edit");
  const copy = [...t.vault.files.keys()].find((p) => p.includes("(conflict"))!;
  assert.equal(t.vault.read(copy), "agent edit");
});

test("pre-write check: a file edited in Drive during the sync is not trashed", async () => {
  const t = setup();
  const id = t.drive.mkdirp("Obsidian/Test");
  const fid = t.drive.putFile(id, "a.md", "v1");
  await t.sync();

  t.vault.files.delete("a.md");
  t.drive.afterList = () => void t.drive.updateFile(fid, buf("agent edit"));
  const r = await t.sync();
  assert.deepEqual(r.deferred, ["a.md"]);
  assert.equal(t.drive.readFile(id, "a.md"), "agent edit");

  const r2 = await t.sync();
  assert.equal(r2.downloaded, 1);
  assert.equal(t.vault.read("a.md"), "agent edit");
});
