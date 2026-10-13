import type { Space } from "../domain/types";
import type { Repository } from "./repository";
let connection: Promise<IDBDatabase> | undefined;
function db() {
  if (!connection)
    connection = new Promise((resolve, reject) => {
      const request = indexedDB.open("style-studio", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("spaces");
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          connection = undefined;
        };
        resolve(request.result);
      };
      request.onerror = () => {
        connection = undefined;
        reject(request.error);
      };
    });
  return connection;
}
async function read(id: string): Promise<Space | undefined> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction("spaces", "readonly");
    const request = tx.objectStore("spaces").get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function write(id: string, space: Space) {
  const database = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = database.transaction("spaces", "readwrite");
    tx.objectStore("spaces").put(space, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
export const indexedDbRepository: Repository = {
  async getActiveProfile() {
    return localStorage.getItem("style-active-profile-v2") || "__personal__";
  },
  async setActiveProfile(id) {
    localStorage.setItem("style-active-profile-v2", id || "__personal__");
  },
  async loadSpace(id) {
    const existing = await read(id);
    if (existing) return existing;
    const legacy = localStorage.getItem("style-profiles-v2");
    if (legacy) {
      const profiles = JSON.parse(legacy);
      const space = Object.prototype.hasOwnProperty.call(profiles, id)
        ? profiles[id]
        : undefined;
      if (space) {
        await write(id, space);
        return space;
      }
    }
    return undefined;
  },
  saveSpace: write,
};
