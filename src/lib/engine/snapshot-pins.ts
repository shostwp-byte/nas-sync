declare global {
  var __nasSyncSnapshotReadPins: Map<string, number> | undefined;
}

function getPinsMap(): Map<string, number> {
  if (!globalThis.__nasSyncSnapshotReadPins) {
    globalThis.__nasSyncSnapshotReadPins = new Map<string, number>();
  }
  return globalThis.__nasSyncSnapshotReadPins;
}

function makePinKey(serverId: number, snapshotName: string): string {
  return `${Number(serverId)}::${String(snapshotName).trim()}`;
}

/**
 * Ghim tạm thời (refcount trong bộ nhớ) một thư mục Snapshot đang được đọc bởi
 * Explorer Download/Archive, Sandbox Verifier, Restore hoặc Offsite Upload
 * để GFS Retention / Job Delete không xóa giữa chừng.
 */
export function acquireSnapshotReadPin(
  serverId: number,
  snapshotName: string
): () => void {
  const cleanSnap = String(snapshotName || '').trim();
  if (!Number.isInteger(serverId) || serverId <= 0 || !cleanSnap) {
    return () => {};
  }
  const map = getPinsMap();
  const key = makePinKey(serverId, cleanSnap);
  map.set(key, (map.get(key) || 0) + 1);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (map.get(key) || 1) - 1;
    if (next <= 0) {
      map.delete(key);
    } else {
      map.set(key, next);
    }
  };
}

export function isSnapshotReadPinned(
  serverId: number,
  snapshotName: string
): boolean {
  const cleanSnap = String(snapshotName || '').trim();
  if (!Number.isInteger(serverId) || serverId <= 0 || !cleanSnap) {
    return false;
  }
  return (getPinsMap().get(makePinKey(serverId, cleanSnap)) || 0) > 0;
}
