import type { Space } from "../domain/types";

/**
 * Storage boundary for the whole app. UI code only talks to this interface so the
 * localStorage implementation can be replaced by on-device SQLite (phase 1) without touching components.
 */
export interface Repository {
  getActiveProfile(): Promise<string>;
  setActiveProfile(id: string): Promise<void>;
  loadSpace(id: string): Promise<Space | undefined>;
  saveSpace(id: string, space: Space): Promise<void>;
}
