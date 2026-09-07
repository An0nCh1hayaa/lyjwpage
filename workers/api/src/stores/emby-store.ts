import { type EmbyNowPlaying, type StoredWatchingItem, currentMirror, imagesMirror, mirror, resumeMirror } from "@shared/emby-store";

export async function setNowPlaying(state: EmbyNowPlaying) {
  await mirror.put(state);
}

export async function clearNowPlaying() {
  await mirror.drop();
}

export async function setResume(items: StoredWatchingItem[]) {
  await resumeMirror.put({ items, at: Date.now() });
}

export async function setCurrentItem(item: StoredWatchingItem) {
  await currentMirror.put({ item, at: Date.now() });
}

/**
 * 图片键 → R2 对象键。
 *
 * 键由代理按 Emby 的 ImageTag 拼出来，图换了键就换，所以映射只增不改。
 * 有上限是因为它只是「代理不必重复上传」的备忘：条目掉出去了，代理下一次
 * 推送会从响应里的 missingImages 得知，把图再传一遍。
 */
const IMAGE_LIMIT = 96;

/** 返回真正落库的那一份：调用方拿它去拼回执和推送，两边看到的裁剪结果才一致 */
export async function setImageObjectKeys(
  objectKeys: Record<string, string>,
): Promise<Record<string, string>> {
  // 对象的键保持插入顺序，超了就从最早的开始丢
  const entries = Object.entries(objectKeys).slice(-IMAGE_LIMIT);
  const trimmed = Object.fromEntries(entries);
  await imagesMirror.put({ objectKeys: trimmed, at: Date.now() });
  return trimmed;
}
