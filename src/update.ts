/**
 * Picks up a new deployment in tabs that were left open.
 *
 * A tab keeps running whatever code it loaded, so after a fix ships, anyone
 * who had axdraw open — a student's tab from yesterday's class — goes on
 * running the old, broken code, and in a shared room that old code can still
 * mix drawings for everyone else. The tab checks /version.json when it comes
 * back into view and every few minutes; when a newer build is out, it reloads
 * at a moment that loses nothing: the scene is saved first, and never while
 * the user is drawing or typing.
 */

const CHECK_EVERY_MS = 5 * 60 * 1000;

export function watchForUpdates(options: { busy: () => boolean; beforeReload: () => void }): void {
  if (!import.meta.env.PROD) return;
  let newer = false;

  const check = async (): Promise<void> => {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}version.json`, { cache: "no-store" });
      if (!response.ok) return;
      const { build } = (await response.json()) as { build?: string };
      if (build && build !== __BUILD_ID__) newer = true;
    } catch {
      // Offline: try again later.
    }
  };

  const reloadIfSafe = (): void => {
    if (!newer || options.busy()) return;
    options.beforeReload();
    location.reload();
  };

  document.addEventListener("visibilitychange", () => {
    // Going out of view is the safest moment of all; coming back is when
    // stale code would otherwise start acting again.
    void check().then(reloadIfSafe);
  });
  setInterval(() => void check().then(reloadIfSafe), CHECK_EVERY_MS);
}
