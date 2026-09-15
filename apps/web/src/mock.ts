/**
 * OpenStore Web Frontend — mock/in-memory demo data (OPENSTORE-023).
 *
 * Explicitly labeled MOCK data used only where backend integration is
 * not yet available. Contains no real identities, keys, phrases, or
 * file contents — every value below is fabricated for layout/QA.
 * Nothing here is ever presented as a real operation result.
 */

import type { CatalogEntry } from "../../client/catalog.js";
import type { WebIdentityStatus, WebNode } from "./types.js";

export const DEMO_MODE = true;

const HOUR = 3_600_000;

export const MOCK_FILES: CatalogEntry[] = [
  {
    fileId: "demo-file-alpha-001",
    filename: "project-backup.zip",
    size: 12_582_912,
    totalChunks: 3,
    chunkSize: 4_194_304,
    createdAt: 1_787_000_000_000 - 3 * HOUR,
  },
  {
    fileId: "demo-file-beta-002",
    filename: "family-photos.tar",
    size: 4_194_304,
    totalChunks: 1,
    chunkSize: 4_194_304,
    createdAt: 1_787_000_000_000 - 26 * HOUR,
  },
  {
    fileId: "demo-file-gamma-003",
    filename: "notes.txt",
    size: 12_800,
    totalChunks: 1,
    chunkSize: 4_194_304,
    createdAt: 1_787_000_000_000 - 50 * HOUR,
  },
];

export const MOCK_NODES: WebNode[] = [
  {
    id: "demo-node-a-public-key",
    baseUrl: "http://127.0.0.1:4101",
    available: true,
    allocatedBytes: 1_073_741_824,
    usedBytes: 402_653_184,
    availableBytes: 671_088_640,
    score: 92,
    storageScore: 88,
    lastSeen: 1_787_000_000_000 - 5_000,
  },
  {
    id: "demo-node-b-public-key",
    baseUrl: "http://127.0.0.1:4102",
    available: true,
    allocatedBytes: 1_073_741_824,
    usedBytes: 134_217_728,
    availableBytes: 939_524_096,
    score: 74,
    storageScore: 81,
    lastSeen: 1_787_000_000_000 - 12_000,
  },
  {
    id: "demo-node-c-public-key",
    baseUrl: "http://127.0.0.1:4103",
    available: false,
    allocatedBytes: 536_870_912,
    usedBytes: 66_060_288,
    availableBytes: 470_810_624,
    score: 41,
    storageScore: 50,
    lastSeen: 1_787_000_000_000 - 5 * 60_000,
  },
];

export const MOCK_IDENTITY: WebIdentityStatus = {
  configured: false,
  label: "demo — no real identity loaded",
};
