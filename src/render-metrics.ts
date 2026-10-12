import * as THREE from "three";

/** Asynchronous GPU timings; RAF intervals alone cannot identify a GPU bottleneck. */
export class RenderMetrics {
  private readonly gl: WebGL2RenderingContext;
  private readonly extension: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  private frame = 0;
  constructor(private readonly renderer: THREE.WebGLRenderer) {
    // Three r180 requires WebGL 2; its typings retain the legacy union.
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    const software = renderer.domElement.dataset.softwareRenderer === "true";
    this.extension = software ? null : this.gl.getExtension("EXT_disjoint_timer_query_webgl2");
    renderer.domElement.dataset.gpuTiming = software ? "software-disabled" : this.extension ? "available" : "unavailable";
  }
  begin() {
    const gl = this.gl, ext = this.extension;
    // Even availability/disjoint reads cross the driver boundary. Sample rather
    // than placing synchronization points in every animation frame.
    if (ext && this.frame++ % 30 === 0) {
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      while (this.pending.length && (disjoint || gl.getQueryParameter(this.pending[0], gl.QUERY_RESULT_AVAILABLE))) {
        const query = this.pending.shift()!;
        if (!disjoint) this.renderer.domElement.dataset.gpuFrameMs = (gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6).toFixed(2);
        gl.deleteQuery(query);
      }
      if (this.pending.length < 4) {
        this.active = gl.createQuery();
        if (this.active) gl.beginQuery(ext.TIME_ELAPSED_EXT, this.active);
      }
    }
    this.renderer.info.autoReset = false;
    this.renderer.info.reset();
  }
  finish() {
    if (this.active && this.extension) {
      this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
      this.pending.push(this.active); this.active = null;
    }
    const canvas = this.renderer.domElement;
    canvas.dataset.drawCalls = String(this.renderer.info.render.calls);
    canvas.dataset.triangles = String(this.renderer.info.render.triangles);
    canvas.dataset.renderWidth = String(canvas.width);
    canvas.dataset.renderHeight = String(canvas.height);
    this.renderer.info.autoReset = true;
  }
  dispose() {
    if (this.active && this.extension) this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
    if (this.active) this.gl.deleteQuery(this.active);
    this.pending.forEach(query => this.gl.deleteQuery(query)); this.pending = [];
  }
}
