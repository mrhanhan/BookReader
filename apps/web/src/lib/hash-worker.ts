import { createSHA256 } from 'hash-wasm';

/**
 * Incremental SHA-256 worker. Reading 4 MiB slices keeps memory flat even for
 * the 500 MiB upload ceiling; `arrayBuffer()` on a slice only materialises
 * that chunk.
 */
const CHUNK_SIZE_BYTES = 4 * 1024 * 1024;

interface HashRequest {
  file: File;
}

interface HashReply {
  sha256?: string;
  error?: string;
}

/** The DOM lib types `self` as a window, so narrow it to the worker surface. */
interface WorkerScope {
  onmessage: ((event: MessageEvent<HashRequest>) => void) | null;
  postMessage: (message: HashReply) => void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = async (event) => {
  try {
    const { file } = event.data;
    const hasher = await createSHA256();
    hasher.init();

    for (let offset = 0; offset < file.size; offset += CHUNK_SIZE_BYTES) {
      const chunk = file.slice(offset, offset + CHUNK_SIZE_BYTES);
      hasher.update(new Uint8Array(await chunk.arrayBuffer()));
    }

    scope.postMessage({ sha256: hasher.digest('hex') });
  } catch (error) {
    scope.postMessage({
      error: error instanceof Error ? error.message : '无法计算文件校验值',
    });
  }
};
