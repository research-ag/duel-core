import { Injectable } from '@angular/core';
import BaseService from '../../../shared/services/base.service';

@Injectable()
export class RenderingService extends BaseService {

  private _isRunning: boolean = false;

  private _permanentRenderMethods: Map<string, Function>;
  private _singularRenderMethods: Map<string, Function>;

  constructor() {
    super();
    this._permanentRenderMethods = new Map<string, Function>();
    this._singularRenderMethods = new Map<string, Function>();
    this._renderRoutine = this._renderRoutine.bind(this);
  }

  public addPermanentRenderMethod(key: string, method: Function) {
    this._permanentRenderMethods.set(key, method);
    if (!this._isRunning) {
      this.startRenderingLoop();
    }
  }

  public removePermanentRenderMethod(key: string) {
    this._permanentRenderMethods.delete(key);
  }

  public runRenderMethodOnce(key: string, method: Function) {
    this._singularRenderMethods.set(key, method);
    if (!this._isRunning) {
      this.startRenderingLoop();
    }
  }

  ngOnDestroy() {
    super.ngOnDestroy();
    this._permanentRenderMethods.clear();
    this._singularRenderMethods.clear();
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
