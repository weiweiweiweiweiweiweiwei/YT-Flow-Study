// ============================================================================
// 雲端同步的儲存位置：使用者自己的 Google 雲端硬碟
// ============================================================================
//
// 為什麼不用資料庫（以前是 Supabase）：
//   資料庫是給「很多人同時共用同一份資料」用的。FlowStudy 的資料只屬於一個人，
//   每個人存在自己的雲端硬碟就夠了，也不用擔心免費資料庫閒置太久被暫停。
//
// 存在哪裡：雲端硬碟的「應用程式專用資料夾」（appDataFolder）。
//   這個資料夾不會出現在使用者的檔案列表裡，也只有 FlowStudy 讀得到；
//   授權範圍 drive.appdata 也只能碰這個資料夾，看不到使用者其他任何檔案。
//
// 檔案內容：一個 JSON，每一筆紀錄一列，欄位跟以前 Supabase 的 sync_records 表一樣：
//   { version: 1, rows: { "<store>/<record_id>": { store, record_id, data, deleted, updated_at } } }
// 所以同步引擎（core/cloud/sync.js）完全不用改，它只認得 pull / push 這兩個動作。
//
// 兩台電腦同時同步怎麼辦：
//   雲端硬碟不是資料庫，整個檔案是一起覆蓋的。上傳之前先看檔案的版本號，
//   跟我們下載時不一樣（別台電腦剛寫過），就先把新的那份讀回來合併，再寫上去。
//   每一列各自比 updated_at，新的贏，不會因為整個檔案被覆蓋而丟掉別台電腦剛推的資料。
// ============================================================================

export const DRIVE_FILE_NAME = "flowstudy-sync.json";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

function emptyDoc() {
  return { version: 1, rows: {} };
}

function rowKey(row) {
  return `${row.store}/${row.record_id}`;
}

/**
 * getToken()      → 現在可以用的 access token（快過期會自己換新）
 * renewToken()    → 被雲端硬碟拒絕（401）時呼叫，強制換一次新的
 * fetchImpl       → 測試時換成假的
 * now()           → 測試時換成假的時鐘
 */
export function createDriveApi({ getToken, renewToken, fetchImpl = fetch, now = () => Date.now() }) {
  let fileId = null;
  let version = null; // 我們上次讀到／寫入的檔案版本
  let doc = null; // 這一輪同步期間讀進來的內容（每次同步都會建一個新的 api，不會沿用舊的）
  let lastStamp = 0;

  async function call(url, init = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = attempt === 0 ? await getToken() : await renewToken();
      if (!token) throw new Error("Google 登入已過期，請在設定重新登入");
      const res = await fetchImpl(url, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
      });
      if (res.status === 401 && attempt === 0) continue; // token 剛好過期：換新的再試一次
      if (!res.ok) {
        let detail = "";
        try {
          const body = await res.json();
          detail = (body.error && (body.error.message || body.error.status)) || "";
        } catch (e) {}
        if (res.status === 403 && /has not been used|is disabled/i.test(detail)) {
          throw new Error("Google Cloud 專案還沒啟用 Google Drive API（API 和服務 → 程式庫 → Google Drive API → 啟用）");
        }
        throw new Error(`雲端硬碟回應錯誤（HTTP ${res.status}）${detail ? "：" + detail : ""}`);
      }
      return res;
    }
    throw new Error("Google 登入已過期，請在設定重新登入");
  }

  async function findFile() {
    const params = new URLSearchParams({
      spaces: "appDataFolder",
      q: `name = '${DRIVE_FILE_NAME}' and trashed = false`,
      fields: "files(id,version)",
      orderBy: "createdTime",
      pageSize: "10",
    });
    const res = await call(`${API}/files?${params}`);
    const { files } = await res.json();
    // 理論上只有一個；萬一兩台電腦第一次同步時各建了一個，固定用最早建立的那個
    return files && files.length ? files[0] : null;
  }

  async function getVersion() {
    const res = await call(`${API}/files/${fileId}?fields=version`);
    return (await res.json()).version;
  }

  async function download() {
    const res = await call(`${API}/files/${fileId}?alt=media`);
    const text = await res.text();
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.rows === "object" && parsed.rows) return parsed;
    } catch (e) {}
    // 檔案壞掉（理論上不會）：絕對不能當成「雲端是空的」然後整個覆蓋掉，寧可這次同步失敗
    throw new Error("雲端硬碟上的同步檔讀不懂，這次先不同步");
  }

  async function load() {
    if (doc) return doc;
    const file = await findFile();
    if (!file) {
      doc = emptyDoc();
      return doc;
    }
    fileId = file.id;
    doc = await download();
    version = await getVersion(); // 下載後才問版本：寧可多合併一次，也不要漏掉別台電腦剛寫的
    return doc;
  }

  function multipartBody(metadata, content) {
    const boundary = "flowstudy" + Math.random().toString(36).slice(2);
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${content}\r\n` +
      `--${boundary}--`;
    return { body, contentType: `multipart/related; boundary=${boundary}` };
  }

  async function upload() {
    const content = JSON.stringify(doc);
    if (!fileId) {
      const { body, contentType } = multipartBody({ name: DRIVE_FILE_NAME, parents: ["appDataFolder"], mimeType: "application/json" }, content);
      const res = await call(`${UPLOAD}/files?uploadType=multipart&fields=id,version`, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body,
      });
      const created = await res.json();
      fileId = created.id;
      version = created.version;
      return;
    }
    const res = await call(`${UPLOAD}/files/${fileId}?uploadType=media&fields=version`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: content,
    });
    version = (await res.json()).version;
  }

  // 兩份內容逐列合併，updated_at 新的贏
  function mergeInto(target, incoming) {
    for (const [key, row] of Object.entries(incoming.rows || {})) {
      const mine = target.rows[key];
      if (!mine || String(row.updated_at) > String(mine.updated_at)) target.rows[key] = row;
    }
  }

  // 每一列的時間都不一樣、而且一定往後走：同一批推上去的資料不會擠在同一個時間點
  function stamp() {
    lastStamp = Math.max(now(), lastStamp + 1);
    return new Date(lastStamp).toISOString();
  }

  return {
    // 依 updated_at 由舊到新，回傳「cursor 之後」的所有列（一次全給：資料在記憶體裡，不必分頁）
    async pull(cursor) {
      const d = await load();
      return Object.values(d.rows)
        .filter((r) => !cursor || r.updated_at >= cursor)
        .sort((a, b) =>
          a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : a.record_id < b.record_id ? -1 : a.record_id > b.record_id ? 1 : 0
        )
        .map((r) => JSON.parse(JSON.stringify(r)));
    },

    // 每一批都立刻寫上雲端：同步引擎在 push 成功之後才把這些紀錄記成「已同步」，
    // 所以不能先累積起來最後才寫——中途失敗的話，沒寫上去的資料會被當成已同步而永遠不再推
    async push(rows) {
      if (!rows.length) return;
      await load();
      if (fileId) {
        const current = await getVersion();
        if (current !== version) {
          // 別台電腦在這之間寫過：先把它的版本合併進來，免得覆蓋掉它推的資料
          mergeInto(doc, await download());
          version = current;
        }
      }
      for (const r of rows) {
        doc.rows[rowKey(r)] = {
          store: r.store,
          record_id: String(r.record_id),
          data: r.deleted ? {} : r.data,
          deleted: !!r.deleted,
          updated_at: stamp(),
        };
      }
      await upload();
    },
  };
}
