// The Agents asset route serves one compiled stylesheet. Feature-local styles
// are installed once rather than emitting an unserved second CSS bundle.
export const installDiagramStyles = (): void => {
  if (document.getElementById('mermaid-viewer-styles')) return
  const style = document.createElement('style')
  style.id = 'mermaid-viewer-styles'
  style.textContent = `
.diagram-viewer{margin:.5rem 0;color:var(--text);min-width:0}
.diagram-controls{display:flex;align-items:center;gap:.375rem;flex-wrap:wrap;padding:.375rem 0;flex-shrink:0}
.diagram-controls button,.diagram-actions button{font:inherit;font-size:.8125rem;padding:.3rem .55rem;border:1px solid var(--border);border-radius:.3rem;background:var(--surface);color:var(--text);min-height:30px}
.diagram-controls button:disabled,.diagram-actions button:disabled{opacity:.45}
.diagram-controls button:not(:disabled):hover,.diagram-actions button:not(:disabled):hover{background:var(--surface-muted)}
.diagram-scale{font-size:.75rem;color:var(--text-muted);font-variant-numeric:tabular-nums;min-width:3.2em;text-align:center}
.diagram-viewport{overflow:auto;max-height:60vh;min-height:5rem;min-width:0;overscroll-behavior:auto;position:relative}
.diagram-stage{margin:0;flex-shrink:0;position:relative}
.diagram-stage>svg{display:block;width:100%!important;height:100%!important;max-width:none!important}
.diagram-dialog{box-sizing:border-box;margin:auto;padding:0;width:92vw;height:88vh;max-width:98vw;max-height:96vh;min-width:min(320px,96vw);min-height:240px;resize:both;overflow:hidden;border:1px solid var(--border);border-radius:.5rem;background:var(--surface);color:var(--text)}
.diagram-dialog::backdrop{background:var(--shadow-overlay)}
.diagram-dialog.is-maximized{width:98vw!important;height:96vh!important;resize:none}
.diagram-dialog-shell{height:100%;display:flex;flex-direction:column;min-width:0}
.diagram-dialog-header{display:flex;align-items:center;justify-content:space-between;gap:.5rem;border-bottom:1px solid var(--border);padding:.5rem .75rem;flex-shrink:0;flex-wrap:wrap}
.diagram-dialog-title{margin:0;font-size:1rem;font-weight:500}
.diagram-dialog-body{padding:.5rem .75rem;display:flex;flex-direction:column;flex:1;min-height:0;min-width:0;overflow:auto}
.diagram-dialog .diagram-viewport{flex:1;max-height:none;min-height:60px}
.diagram-dialog-note,.diagram-version-label{font-size:.75rem;color:var(--text-muted)}
.diagram-editor{display:flex;flex-direction:column;gap:.375rem;min-height:0;max-height:42%;flex-shrink:0}
.diagram-editor[hidden],.diagram-ask[hidden]{display:none}
.diagram-editor textarea{width:100%;box-sizing:border-box;min-height:6rem;resize:vertical;font:inherit;font-family:monospace;font-size:.8125rem;padding:.5rem}
.diagram-actions{display:flex;gap:.375rem;align-items:center;flex-wrap:wrap;padding:.25rem 0}
.diagram-status{font-size:.8125rem;flex-shrink:0;white-space:pre-wrap}
.diagram-status[data-error=true]{color:var(--danger)}
.diagram-ask{border-top:1px solid var(--border);padding-top:.5rem;display:flex;gap:.375rem;align-items:flex-end;flex-shrink:0}
.diagram-ask label{font-size:.8125rem;flex:1;min-width:0}
.diagram-ask textarea{display:block;width:100%;box-sizing:border-box;min-height:2.75rem;max-height:6rem;resize:vertical;font:inherit;padding:.375rem}
.diagram-dialog-shell:fullscreen{box-sizing:border-box;width:100vw;height:100vh;background:var(--surface);color:var(--text)}
@media(max-width:480px){.diagram-dialog{width:98vw;height:96vh}.diagram-dialog-body{padding:.375rem}.diagram-controls{gap:.25rem}.diagram-ask{flex-wrap:wrap}.diagram-ask label{flex-basis:100%}}
@media(pointer:coarse){.diagram-controls button,.diagram-actions button{min-height:44px;min-width:44px}}
`
  document.head.append(style)
}
