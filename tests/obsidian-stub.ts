// Minimal stand-in for the "obsidian" module so sync logic can run under Node.
export class TFile {
  constructor(public path: string, public stat: { mtime: number; size: number; ctime: number }) {}
}
export class TFolder {
  constructor(public path: string) {}
}
export class Notice {
  constructor(_msg?: string, _timeout?: number) {}
}
export type App = unknown;
export type RequestUrlResponse = unknown;
export function requestUrl(): never {
  throw new Error("network disabled in tests");
}
export class PluginSettingTab {
  constructor(_app?: unknown, _plugin?: unknown) {}
}
export class Setting {}
