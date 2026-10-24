import { requestUrl, RequestUrlResponse } from "obsidian";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
export const FOLDER_MIME = "application/vnd.google-apps.folder";
const FIELDS = "id,name,mimeType,md5Checksum,modifiedTime,size";

export interface RemoteFile {
  id: string;
  name: string;
  mimeType: string;
  md5Checksum?: string;
  modifiedTime: string;
  size?: string;
  trashed?: boolean;
  parents?: string[];
}

/** One entry of the Drive changes feed. */
export interface DriveChange {
  fileId: string;
  removed?: boolean;
  file?: RemoteFile;
}

export interface RemoteTree {
  files: Map<string, RemoteFile>; // vault-relative path -> file
  folders: Map<string, string>; // vault-relative folder path -> folder id ("" = root)
  warnings: string[];
}

export interface ListTreeOptions {
  /** Folders listed at the same time (default 8). */
  concurrency?: number;
  /** Return true for a vault-relative folder path that should not be listed at all. */
  skipFolder?: (path: string) => boolean;
  /** Folders listed so far / folders known so far. */
  onProgress?: (done: number, total: number) => void;
}

interface ChangeList {
  changes: DriveChange[];
  nextPageToken?: string;
  newStartPageToken?: string;
}

interface FileList {
  files: RemoteFile[];
  nextPageToken?: string;
}

function q(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

export class DriveClient {
  constructor(private getToken: () => Promise<string>) {}

  private async req(
    url: string,
    opts: { method?: string; body?: string | ArrayBuffer; contentType?: string } = {}
  ): Promise<RequestUrlResponse> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken();
      const r = await requestUrl({
        url,
        method: opts.method ?? "GET",
        body: opts.body,
        contentType: opts.contentType,
        headers: { Authorization: `Bearer ${token}` },
        throw: false,
      });
      if ((r.status === 429 || r.status >= 500) && attempt < 4) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (r.status >= 400) {
        let detail = "";
        try {
          detail = r.text.slice(0, 300);
        } catch {
          /* binary body */
        }
        throw new Error(`Drive API ${r.status}: ${detail}`);
      }
      return r;
    }
  }

  async listChildren(folderId: string): Promise<RemoteFile[]> {
    const out: RemoteFile[] = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({
        q: `'${q(folderId)}' in parents and trashed = false`,
        fields: `nextPageToken, files(${FIELDS})`,
        pageSize: "1000",
        spaces: "drive",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const r = await this.req(`${API}/files?${params.toString()}`);
      const body = r.json as FileList;
      out.push(...body.files);
      pageToken = body.nextPageToken ?? "";
    } while (pageToken);
    return out;
  }

  async createFolder(name: string, parentId: string): Promise<string> {
    const r = await this.req(`${API}/files?fields=id`, {
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    return (r.json as RemoteFile).id;
  }

  /**
   * Resolve a path like "Obsidian/My Vault" under My Drive, creating missing folders.
   * `created` tells the caller the folder did not exist before this call.
   */
  async ensureFolderPath(path: string): Promise<{ id: string; created: boolean }> {
    let parent = "root";
    let created = false;
    for (const name of path.split(/[/\\]/).map((s) => s.trim()).filter(Boolean)) {
      const params = new URLSearchParams({
        q: `'${q(parent)}' in parents and name = '${q(name)}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
        fields: "files(id)",
        spaces: "drive",
      });
      const r = await this.req(`${API}/files?${params.toString()}`);
      const found = (r.json as FileList).files;
      if (found.length) parent = found[0].id;
      else {
        parent = await this.createFolder(name, parent);
        created = true;
      }
    }
    return { id: parent, created };
  }

  /** Token marking "now" in the changes feed; take it before a full listing. */
  async getStartPageToken(): Promise<string> {
    const r = await this.req(`${API}/changes/startPageToken`);
    return (r.json as { startPageToken: string }).startPageToken;
  }

  /** Every change since `token`, and the token to use next time. */
  async listChanges(token: string): Promise<{ changes: DriveChange[]; newToken: string }> {
    const changes: DriveChange[] = [];
    let page = token;
    for (;;) {
      const params = new URLSearchParams({
        pageToken: page,
        pageSize: "1000",
        spaces: "drive",
        includeRemoved: "true",
        fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FIELDS},trashed,parents))`,
      });
      const r = await this.req(`${API}/changes?${params.toString()}`);
      const body = r.json as ChangeList;
      changes.push(...body.changes);
      if (body.nextPageToken) page = body.nextPageToken;
      else if (body.newStartPageToken) return { changes, newToken: body.newStartPageToken };
      else throw new Error("Drive changes feed returned no next token.");
    }
  }

  /** Current metadata of one file or folder, including whether it is in the trash. */
  async getFile(id: string): Promise<RemoteFile> {
    const r = await this.req(`${API}/files/${encodeURIComponent(id)}?fields=${FIELDS},trashed,parents`);
    return r.json as RemoteFile;
  }

  /**
   * List every file under rootId. Folders are listed `concurrency` at a time.
   * `skipFolder(path)` prunes folders that are never synced (hidden, excluded).
   * Any listing error rejects the whole call: a partial tree would look like
   * deletions to the sync.
   */
  async listTree(rootId: string, opts: ListTreeOptions = {}): Promise<RemoteTree> {
    const concurrency = Math.max(1, opts.concurrency ?? 8);
    const files = new Map<string, RemoteFile>();
    const folders = new Map<string, string>([["", rootId]]);
    const warnings: string[] = [];
    const queue: [string, string][] = [["", rootId]];
    let active = 0;
    let done = 0;
    let failed: unknown = null;

    await new Promise<void>((resolve, reject) => {
      const pump = () => {
        if (failed) return;
        if (!queue.length && active === 0) return resolve();
        while (active < concurrency && queue.length) {
          const [prefix, id] = queue.shift() as [string, string];
          active++;
          this.listChildren(id).then(
            (children) => {
              active--;
              if (failed) return;
              for (const f of children) {
                const path = prefix ? `${prefix}/${f.name}` : f.name;
                if (f.mimeType === FOLDER_MIME) {
                  if (!folders.has(path) && !opts.skipFolder?.(path)) {
                    folders.set(path, f.id);
                    queue.push([path, f.id]);
                  }
                } else if (f.mimeType.startsWith("application/vnd.google-apps.")) {
                  continue; // Google Docs/Sheets etc. can't be downloaded as files
                } else if (files.has(path)) {
                  warnings.push(`Duplicate name in Drive, ignoring extra copy: ${path}`);
                } else {
                  files.set(path, f);
                }
              }
              done++;
              opts.onProgress?.(done, done + active + queue.length);
              pump();
            },
            (e) => {
              active--;
              if (!failed) {
                failed = e;
                reject(e instanceof Error ? e : new Error(String(e)));
              }
            }
          );
        }
      };
      pump();
    });
    return { files, folders, warnings };
  }

  async download(id: string): Promise<ArrayBuffer> {
    const r = await this.req(`${API}/files/${id}?alt=media`);
    return r.arrayBuffer;
  }

  async createFile(name: string, parentId: string, data: ArrayBuffer): Promise<RemoteFile> {
    const boundary = "gsync-" + Math.random().toString(36).slice(2);
    const enc = new TextEncoder();
    const head = enc.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify({ name, parents: [parentId] }) +
        `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`
    );
    const tail = enc.encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(head.length + data.byteLength + tail.length);
    body.set(head, 0);
    body.set(new Uint8Array(data), head.length);
    body.set(tail, head.length + data.byteLength);
    const r = await this.req(`${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`, {
      method: "POST",
      contentType: `multipart/related; boundary=${boundary}`,
      body: body.buffer,
    });
    return r.json as RemoteFile;
  }

  async updateFile(id: string, data: ArrayBuffer): Promise<RemoteFile> {
    const r = await this.req(`${UPLOAD}/files/${id}?uploadType=media&fields=${FIELDS}`, {
      method: "PATCH",
      contentType: "application/octet-stream",
      body: data,
    });
    return r.json as RemoteFile;
  }

  /** Moves to Drive's trash (recoverable for 30 days), never hard-deletes. */
  async trash(id: string): Promise<void> {
    await this.req(`${API}/files/${id}`, {
      method: "PATCH",
      contentType: "application/json",
      body: JSON.stringify({ trashed: true }),
    });
  }
}
