// ============================================================================
// 影片倉儲層
// ============================================================================
// 很輕的一層。存在的目的是讓單字與分析資料能指回「真正的影片」，
// 而不是在每一筆 occurrence 裡重複存一次影片標題。
// ============================================================================

import { STORES, withStore, getAll, getById, put } from "./db.js";
import { createVideo, nowIso } from "../models.js";

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getVideo(videoId) {
  return getById(STORES.VIDEOS, videoId);
}

export async function getAllVideos() {
  return getAll(STORES.VIDEOS);
}

// 有就更新、沒有就建立。標題與長度只在「原本是空的」時候才補上，
// 避免 YouTube 偶爾回傳空標題時把已經存好的正確標題洗掉。
export async function upsertVideo({ videoId, title = "", duration = 0 } = {}) {
  if (!videoId) return null;
  return withStore(STORES.VIDEOS, "readwrite", async (store) => {
    const existing = await promisify(store.get(videoId));
    const video = existing || createVideo({ videoId, title, duration });
    if (title) video.title = title;
    if (duration && !video.duration) video.duration = duration;
    video.lastWatchedAt = nowIso();
    await promisify(store.put(video));
    return video;
  });
}

export async function getVideoMap() {
  const all = await getAllVideos();
  const map = {};
  for (const v of all) map[v.videoId] = v;
  return map;
}

export { put };
