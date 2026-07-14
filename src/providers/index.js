// Storage-provider registry. Adding a new cloud (Dropbox, OneDrive, Box, S3…)
// is a one-line change here + a module implementing the interface documented in
// ./google_drive.js — the pipeline, sync, and server code stay untouched.
import * as googleDrive from './google_drive.js';
// import * as dropbox from './dropbox.js';   // future
// import * as oneDrive from './onedrive.js'; // future

const REGISTRY = {
  [googleDrive.key]: googleDrive,
  // [dropbox.key]: dropbox,
  // [oneDrive.key]: oneDrive,
};

export function getProvider(key) {
  const p = REGISTRY[key];
  if (!p) {
    const e = new Error(`unknown storage provider: ${key}`);
    e.status = 400;
    throw e;
  }
  return p;
}

export function listProviders() {
  return Object.values(REGISTRY).map((p) => ({ key: p.key, label: p.label }));
}

export function isSupported(key) {
  return Object.prototype.hasOwnProperty.call(REGISTRY, key);
}
