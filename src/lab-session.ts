export const LAB_SESSION_KEY = 'edgelab-session';

export type ExistingLabSession =
  { status: 'available'; id: string } | { status: 'missing' | 'storage-unavailable' };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let mainLabSession: string | null = null;

/** Reading an observer session never creates or replaces its capability. */
export function readExistingLabSession(): ExistingLabSession {
  try {
    const id = localStorage.getItem(LAB_SESSION_KEY);
    return id && uuid.test(id) ? { status: 'available', id } : { status: 'missing' };
  } catch {
    return { status: 'storage-unavailable' };
  }
}

/** The main lab keeps its capability stable, including its in-memory fallback. */
export function getMainLabSession(): string {
  if (mainLabSession) return mainLabSession;
  const existing = readExistingLabSession();
  mainLabSession = existing.status === 'available' ? existing.id : crypto.randomUUID();
  if (existing.status !== 'available') {
    try {
      localStorage.setItem(LAB_SESSION_KEY, mainLabSession);
    } catch {
      // Main-lab commands still work when browser storage is unavailable.
    }
  }
  return mainLabSession;
}
