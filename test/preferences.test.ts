import { describe, expect, it } from "vitest";
import {
  LocalPreferenceStore,
  defaultPreferences,
  preferenceStorageKey,
  sanitizePreferences,
} from "../src/daily/preferences.js";

class RecordingStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

describe("daily-driver preferences", () => {
  it("migrates version 1 through a strict non-secret projection", () => {
    const migrated = sanitizePreferences({
      version: 1,
      endpoint: "http://localhost:8787",
      density: "compact",
      columns: ["provider", "privateMetadata", "provider"],
      query: { status: "blocked", provider: "demo", sort: { field: "name", direction: "asc" }, text: "private search" },
      token: "must be dropped",
      recentAgents: ["private-session-id"],
    });

    expect(migrated).toEqual({
      version: 2,
      endpoint: "http://localhost:8787/",
      density: "compact",
      columns: ["provider"],
      query: { status: "blocked", provider: "demo", sort: { field: "name", direction: "asc" } },
      savedViews: [],
    });
    expect(JSON.stringify(migrated)).not.toMatch(/token|private search|private-session/i);
  });

  it("fails closed for corrupt, future, and unsafe preference payloads", () => {
    expect(sanitizePreferences({ version: 99, endpoint: "https://remote.example" })).toBe(defaultPreferences);
    expect(sanitizePreferences({ version: 2, endpoint: "http://user:secret@localhost:8787?token=x" }).endpoint)
      .toBe(defaultPreferences.endpoint);
    expect(sanitizePreferences(Object.create({ version: 2 }))).toBe(defaultPreferences);
  });

  it("round-trips only bounded preferences and clears them", () => {
    const storage = new RecordingStorage();
    const store = new LocalPreferenceStore(storage);
    store.save({ ...defaultPreferences, density: "compact", savedViews: [{ id: "attention", name: "Attention", status: "blocked", provider: "demo", sort: { field: "status", direction: "asc" } }] });

    expect(store.load()).toMatchObject({ density: "compact", savedViews: [{ id: "attention" }] });
    expect(storage.values.get(preferenceStorageKey)).not.toMatch(/credential|prompt|command|cwd|snapshot/i);
    store.clear();
    expect(storage.values.has(preferenceStorageKey)).toBe(false);
  });

  it("ignores oversized or malformed local data without exposing it", () => {
    const storage = new RecordingStorage();
    const store = new LocalPreferenceStore(storage);
    storage.values.set(preferenceStorageKey, "x".repeat(32_769));
    expect(store.load()).toBe(defaultPreferences);
    storage.values.set(preferenceStorageKey, "{not-json");
    expect(store.load()).toBe(defaultPreferences);
  });
});
