/**
 * Mutex sederhana berbasis promise-chain.
 * Dipakai untuk menyerialkan akses ke resource yang tidak boleh diakses
 * bersamaan — mis. private API Indodax (nonce harus naik ketat) dan
 * monitor posisi (mencegah double-close pada trade yang sama).
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const previous = this.tail;
    this.tail = previous.then(() => gate);

    await previous;
    try {
      return await fn();
    } finally {
      release!();
    }
  }
}

/**
 * Kumpulan mutex yang di-key per string (mis. per trade id / per pair),
 * sehingga operasi pada key berbeda tetap bisa berjalan paralel.
 */
export class KeyedMutex {
  private readonly locks = new Map<string, Mutex>();

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let lock = this.locks.get(key);
    if (!lock) {
      lock = new Mutex();
      this.locks.set(key, lock);
    }
    return lock.runExclusive(fn);
  }

  /** Buang lock yang sudah tidak dipakai agar Map tidak tumbuh tanpa batas. */
  forget(key: string): void {
    this.locks.delete(key);
  }
}
