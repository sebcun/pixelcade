function clearUnpublishedMarkers(gameId) {
  const id = String(gameId);
  document
    .querySelectorAll(`[data-unpublished-marker][data-game-id="${id}"]`)
    .forEach((el) => {
      el.hidden = true;
    });
}

if (typeof document !== "undefined") {
  document.addEventListener("pixelcade-game-published", (e) => {
    const id = e.detail && e.detail.gameId;
    if (id) clearUnpublishedMarkers(id);
  });
}

export function notifyGamePublished(gameId) {
  const id = String(gameId);
  window.dispatchEvent(
    new CustomEvent("pixelcade-game-published", { detail: { gameId: id } })
  );
}
