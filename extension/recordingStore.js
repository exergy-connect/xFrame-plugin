const FRAMEIT_DB_NAME = "exergy-frame";
const FRAMEIT_DB_VERSION = 1;
const FRAMEIT_STORE = "recordings";
const FRAMEIT_PENDING_KEY = "pending";
const FRAMEIT_LAST_KEY = "last";

function openRecordingDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(FRAMEIT_DB_NAME, FRAMEIT_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FRAMEIT_STORE)) {
        db.createObjectStore(FRAMEIT_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("Failed to open recording database"));
  });
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("IndexedDB request failed"));
  });
}

function waitForTransaction(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error || new Error("IndexedDB transaction failed"));
    tx.onabort = () =>
      reject(tx.error || new Error("IndexedDB transaction aborted"));
  });
}

/** Store blob for download (pending) and keep a copy for Animate (last). */
async function putPendingRecording(blob) {
  const db = await openRecordingDb();
  try {
    const tx = db.transaction(FRAMEIT_STORE, "readwrite");
    const store = tx.objectStore(FRAMEIT_STORE);
    store.put(blob, FRAMEIT_PENDING_KEY);
    store.put(blob, FRAMEIT_LAST_KEY);
    await waitForTransaction(tx);
  } finally {
    db.close();
  }
}

async function takePendingRecording() {
  const db = await openRecordingDb();
  try {
    const tx = db.transaction(FRAMEIT_STORE, "readwrite");
    const store = tx.objectStore(FRAMEIT_STORE);
    const blob = await idbRequest(store.get(FRAMEIT_PENDING_KEY));
    store.delete(FRAMEIT_PENDING_KEY);
    await waitForTransaction(tx);
    return blob || null;
  } finally {
    db.close();
  }
}

async function clearPendingRecording() {
  const db = await openRecordingDb();
  try {
    const tx = db.transaction(FRAMEIT_STORE, "readwrite");
    tx.objectStore(FRAMEIT_STORE).delete(FRAMEIT_PENDING_KEY);
    await waitForTransaction(tx);
  } finally {
    db.close();
  }
}

/** Read-only copy of the last saved recording (not consumed by saver). */
async function getLastRecording() {
  const db = await openRecordingDb();
  try {
    const tx = db.transaction(FRAMEIT_STORE, "readonly");
    // Do not await tx completion after get: the readonly transaction may
    // already have fired oncomplete, which would hang waitForTransaction.
    const blob = await idbRequest(tx.objectStore(FRAMEIT_STORE).get(FRAMEIT_LAST_KEY));
    return blob || null;
  } finally {
    db.close();
  }
}

async function hasLastRecording() {
  const blob = await getLastRecording();
  return Boolean(blob && blob.size > 0);
}
