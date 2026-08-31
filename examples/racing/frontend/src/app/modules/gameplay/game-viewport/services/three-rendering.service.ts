
export class ThreeRenderingService {

  private _isRunning: boolean = false;

  private _permanentRenderMethods: Map<number, Function>;
  private _singularRenderMethods: Map<number, Function>;

  constructor() {
    this._permanentRenderMethods = new Map<number, Function>();
    this._singularRenderMethods = new Map<number, Function>();
    this._renderRoutine = this._renderRoutine.bind(this);
  }

  public addPermanentRenderMethod(canvasIndex: number, method: Function) {
    this._permanentRenderMethods.set(canvasIndex, method);
    if (!this._isRunning) {
      this.startRenderingLoop();
    }
  }

  public removePermanentRenderMethod(canvasIndex: number) {
    this._permanentRenderMethods.delete(canvasIndex);
  }

  public runRenderMethodOnce(canvasIndex: number, method: Function) {
    this._singularRenderMethods.set(canvasIndex, method);
    if (!this._isRunning) {
      this.startRenderingLoop();
    }
  }

  private startRenderingLoop(): void {
    this._isRunning = true;
    requestAnimationFrame(this._renderRoutine);
  }

  private stopRenderingLoop(): void {
    this._isRunning = false;
  }

  private _renderRoutine(): void {
    for (let method of this._permanentRenderMethods.values()) {
      method();
    }
    for (let method of this._singularRenderMethods.values()) {
      method();
    }
    this._singularRenderMethods.clear();
    if (this._permanentRenderMethods.size === 0) {
      this.stopRenderingLoop();
    }
    if (this._isRunning) {
      requestAnimationFrame(this._renderRoutine);
    }
  }

}
