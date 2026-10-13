import type { Space } from "../domain/types";
import type { Repository } from "./repository";

// Same keys as the original prototype, so existing browser data keeps working.
const PROFILE_KEY = "style-profiles-v2";
const ACTIVE_KEY = "style-active-profile-v2";

const readAll = (): Record<string, Space> => {
  const raw = localStorage.getItem(PROFILE_KEY);
  return raw ? JSON.parse(raw) : {};
};

export const localStorageRepository: Repository = {
  async getActiveProfile() {
    return localStorage.getItem(ACTIVE_KEY) || "";
  },
  async setActiveProfile(id) {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  },
  async loadSpace(id) {
    return readAll()[id];
  },
  async saveSpace(id, space) {
    const all = readAll();
    all[id] = space;
    localStorage.setItem(PROFILE_KEY, JSON.stringify(all));
  },
};
