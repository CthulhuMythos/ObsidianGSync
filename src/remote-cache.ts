import { DriveChange, FOLDER_MIME, RemoteFile, RemoteTree } from "./drive";

/**
 * The remote tree as of the last listing, plus the Drive changes-feed token to
 * continue from. Lets a sync read only what changed instead of every folder.
 */
export interface RemoteSnapshot {
  version: 1;
  rootId: string;
  /** Changes-feed token taken just before the listing this snapshot is built on. */
  token: string;
  /** When the last full listing was taken (ms); 0 forces a full listing next time. */
  fullAt: number;
  /** Identifies the folder-skipping rules the snapshot was built with. */
  skipKey: string;
  files: Record<string, RemoteFile>;
  folders: Record<string, string>;
}

const NATIVE_PREFIX = "application/vnd.google-apps.";

const join = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);

const slim = (f: RemoteFile): RemoteFile => ({
  id: f.id,
  name: f.name,
  mimeType: f.mimeType,
  md5Checksum: f.md5Checksum,
  modifiedTime: f.modifiedTime,
  size: f.size,
});

export function toSnapshot(tree: RemoteTree, rootId: string, token: string, fullAt: number, skipKey: string): RemoteSnapshot {
  const files: Record<string, RemoteFile> = {};
  for (const [p, f] of tree.files) files[p] = slim(f);
  return { version: 1, rootId, token, fullAt, skipKey, files, folders: Object.fromEntries(tree.folders) };
}

/**
 * Apply changes-feed entries to a snapshot. Returns the updated tree, or the
 * reason a full listing is needed instead. Only file changes are applied
 * incrementally; any change to the folder structure (a known folder renamed,
 * moved, trashed or removed, a new folder inside the tree) or a name clash
 * asks for a full listing, which handles those cases already.
 */
export function applyChanges(
  snap: RemoteSnapshot,
  changes: DriveChange[],
  skipFolder: (path: string) => boolean
): { tree: RemoteTree } | { rescan: string } {
  const files = new Map(Object.entries(snap.files));
  const folders = new Map(Object.entries(snap.folders));
  const folderPathById = new Map<string, string>();
  for (const [p, id] of folders) folderPathById.set(id, p);
  const pathById = new Map<string, string>();
  for (const [p, f] of files) pathById.set(f.id, p);
  const parentPathOf = (f: RemoteFile) => folderPathById.get(f.parents?.[0] ?? "");

  for (const c of changes) {
    const f = c.file;
    const gone = !!c.removed || !f || !!f.trashed;
    if (!f && !c.removed) continue; // nothing to apply

    const knownFolder = folderPathById.get(c.fileId);
    if (knownFolder !== undefined) {
      if (gone || !f) return { rescan: knownFolder ? `folder "${knownFolder}" was removed` : "the synced folder was removed" };
      if (knownFolder === "") continue; // the root itself: its own name and place don't matter
      const slash = knownFolder.lastIndexOf("/");
      const parent = slash >= 0 ? knownFolder.slice(0, slash) : "";
      const name = knownFolder.slice(slash + 1);
      if (f.name !== name || parentPathOf(f) !== parent) return { rescan: `folder "${knownFolder}" was renamed or moved` };
      continue; // metadata-only change
    }

    if (f && f.mimeType === FOLDER_MIME) {
      if (gone) continue; // never part of the tree
      const parent = parentPathOf(f);
      if (parent === undefined) continue; // outside the synced folder
      const path = join(parent, f.name);
      if (skipFolder(path)) continue;
      return { rescan: `new folder "${path}"` };
    }

    const oldPath = pathById.get(c.fileId);
    if (oldPath !== undefined) {
      files.delete(oldPath);
      pathById.delete(c.fileId);
    }
    if (gone || !f || f.mimeType.startsWith(NATIVE_PREFIX)) continue;
    const parent = parentPathOf(f);
    if (parent === undefined) continue; // outside the synced folder, or in a skipped one
    const path = join(parent, f.name);
    const clash = files.get(path);
    if (clash && clash.id !== f.id) return { rescan: `two files named "${path}" in Drive` };
    files.set(path, slim(f));
    pathById.set(f.id, path);
  }
  return { tree: { files, folders, warnings: [] } };
}
