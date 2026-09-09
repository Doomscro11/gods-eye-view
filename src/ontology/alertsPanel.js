/**
 * Alerts surface — the visible end of the closed loop.
 *
 * The ontology engine decides WHAT matters; this module makes it VISIBLE and
 * ACTABLE. An alert row is not a notification, it is a decision card: label,
 * severity, evidence — and the governed verbs (track / brief) wired straight
 * back through `store.applyAction`, so the UI and every future surface
 * (voice, scenario tray) travel the same guarded path.
 *
 * DOM-only surface: every piece of logic that can be pure IS pure
 * (`alertSummaryLine`, `briefFilename`) and node-tested; the DOM code is a
 * thin shell over injected elements.
 *
 * @module ontology/alertsPanel
 */

/** Pure one-line summary for an alert row — node-testable. */
export function alertSummaryLine(alert) {
  if (!alert) return '';
  const evidence = alert.evidence?.corridor
    ? `corridor ${alert.evidence.corridor}`
    : alert.evidence?.relatedTo
      ? `${alert.evidence.kind} ${alert.evidence.relatedTo}`
      : alert.evidence?.gapMs !== undefined
        ? `dark ${Math.round(alert.evidence.gapMs / 60000)}m`
        : '';
  return `${alert.label} · ${alert.ruleId}${evidence ? ` · ${evidence}` : ''}`;
}

/** Pure brief filename — node-testable. */
export function briefFilename(isoDate = new Date().toISOString()) {
  return `gev-brief-${isoDate.replace(/[:.]/g, '-').slice(0, 19)}.md`;
}

/**
 * Wire the alert rail + brief button.
 * @param {object} args
 * @param {HTMLElement} args.rail Container for alert rows.
 * @param {HTMLElement} args.briefButton Brief trigger.
 * @param {object} args.store Ontology store (applyAction path).
 * @param {(object) => void} args.onTrack Surface effect for track.
 * @param {(text: string) => void} [args.showToast]
 * @param {(artifact: {markdown: string}) => void} [args.onBriefArtifact]
 *   Host download/copy hook; defaults to an anchor-download of the Markdown.
 */
export function initAlertsSurface({
  rail,
  briefButton,
  store,
  onTrack,
  showToast = () => {},
  onBriefArtifact = null,
}) {
  if (!rail || !store) return null;

  const verbs = {
    onTrack: (object) => onTrack?.(object),
    onBrief: (artifact) => {
      if (onBriefArtifact) {
        onBriefArtifact(artifact);
      } else if (artifact?.markdown && typeof document !== 'undefined') {
        const blob = new Blob([artifact.markdown], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = briefFilename(artifact.brief?.generatedAt);
        a.click();
        URL.revokeObjectURL(url);
      }
      showToast('Brief generated');
    },
  };

  function onAlerts(fresh) {
    for (const alert of fresh) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `ontology-alert ontology-alert--${alert.severity}`;
      row.textContent = alertSummaryLine(alert);
      row.title = 'Track this contact';
      row.addEventListener('click', () => {
        store.applyAction('track', { objectId: alert.objectId });
      });
      rail.prepend(row);
    }
    // Bounded rail: keep the newest 20 cards.
    while (rail.children.length > 20) rail.removeChild(rail.lastChild);
  }

  if (briefButton) {
    briefButton.addEventListener('click', () => {
      const result = store.applyAction('brief');
      if (!result.ok) showToast('Brief failed');
    });
  }

  return { verbs, onAlerts };
}
