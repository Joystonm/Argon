/**
 * Download helpers.
 *
 * Everything the export menu promises is produced here, and each one is a real
 * file the user can open: the JSON round-trips through the same parser that
 * opens a saved project, the SVG is the plan itself, and the PNGs are rendered
 * from the model rather than screenshotted from a canvas with a device pixel
 * ratio guess in it.
 */
import type { Project } from '../model/types.ts';
import { toJSON } from '../model/serialize.ts';
import { planToSvg } from './planSvg.ts';

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'argon';

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a beat to start the download before revoking, otherwise
  // Safari cancels it.
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function saveText(text: string, filename: string, mime: string): void {
  saveBlob(new Blob([text], { type: `${mime};charset=utf-8` }), filename);
}

export function downloadProjectJson(project: Project): void {
  saveText(toJSON(project, true), `${slug(project.name)}.argon.json`, 'application/json');
  useProjectLog('Export project JSON');
}

function useProjectLog(label: string): void {
  // Imported lazily to keep this module free of a store dependency at load.
  void import('../store/useProject.ts').then(({ useProject }) => {
    useProject.getState().log({ actor: 'user', label, ok: true });
  });
}

export function downloadPlanSvg(project: Project, floorId: string | undefined): void {
  const floor = project.floors.find((f) => f.id === floorId) ?? project.floors[0];
  const svg = planToSvg(project, floorId);
  if (!svg) {
    void import('../store/useProject.ts').then(({ useProject }) =>
      useProject.getState().toast('error', 'That floor has nothing on it yet.'),
    );
    return;
  }
  saveText(svg, `${slug(project.name)}-${slug(floor?.name ?? 'plan')}.svg`, 'image/svg+xml');
  useProjectLog(`Export ${floor?.name ?? 'floor'} as SVG`);
}

/**
 * A raster plan.
 *
 * Rendered by parsing the SVG we just generated into an image and painting it
 * onto a canvas, so the PNG is guaranteed to be the same drawing as the SVG —
 * not a separate rasteriser that could drift.
 */
export function downloadPlanPng(project: Project, floorId: string | undefined): Promise<void> {
  const svg = planToSvg(project, floorId);
  if (!svg) {
    return Promise.resolve().then(() => {
      void import('../store/useProject.ts').then(({ useProject }) =>
        useProject.getState().toast('error', 'That floor has nothing on it yet.'),
      );
    });
  }

  return renderSvgToPng(svg, 2048).then((blob) => {
    if (!blob) throw new Error('The browser refused to rasterise the plan.');
    const floor = project.floors.find((f) => f.id === floorId) ?? project.floors[0];
    saveBlob(blob, `${slug(project.name)}-${slug(floor?.name ?? 'plan')}.png`);
    useProjectLog(`Export ${floor?.name ?? 'floor'} as PNG`);
  });
}

/** Serialises SVG to a PNG blob at the given longest edge. */
export function renderSvgToPng(svg: string, targetPx: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    // A data URL (not a blob URL) so the image is not treated as tainted; the
    // SVG has no external references, so this is safe.
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const img = new Image();
    img.onload = () => {
      const vb = svg.match(/viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/);
      const ratio = vb ? Number(vb[3]) / Number(vb[4]) : 1;
      const scale = targetPx / Math.max(1, Number(vb ? vb[3] : img.width));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round((vb ? Number(vb[3]) : img.width) * scale);
      canvas.height = Math.round(canvas.width * ratio);
      const ctx = canvas.getContext('2d');
      if (!ctx) return resolve(null);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => resolve(blob), 'image/png');
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export function downloadScenePng(blob: Blob, projectName: string): void {
  saveBlob(blob, `${slug(projectName)}-3d.png`);
  useProjectLog('Export 3D capture');
}