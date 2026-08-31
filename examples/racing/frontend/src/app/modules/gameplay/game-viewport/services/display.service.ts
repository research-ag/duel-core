import { BehaviorSubject, lastValueFrom } from 'rxjs';
import { filter, first, map } from 'rxjs/operators';
import { ViewportService } from './viewport.service';
import { ThreeRenderingService } from './three-rendering.service';
import { ThreeScene } from '../entities/three-scene';

type CanvasType = 'three';
type CanvasOptions = {
  transparent: boolean;
  background: number;
}
const getFullCanvasOptions = (options: Partial<CanvasOptions> | null): CanvasOptions => {
  return {
    transparent: false,
    background: 0x000000,
    ...(options || {}),
  }
}

export class DisplayService {

  private readonly canvases: { [key: number]: { canvas: HTMLCanvasElement, type: CanvasType, threeSceneService?: ThreeScene } } = {};
  // the plain DOM element to mount canvases into — see initDisplay(), called
  // once from main.ts with the game stage container.
  private gameStage$: BehaviorSubject<HTMLElement | null> = new BehaviorSubject<HTMLElement | null>(null);

  constructor(private readonly viewport: ViewportService,
              private readonly threeRendering: ThreeRenderingService) {
  }

  initDisplay(stage: HTMLElement) {
    if (this.gameStage$.getValue()) {
      throw new Error('Cannot init display twice! Check DisplayService.initDisplay calls');
    }
    this.gameStage$.next(stage);
  }

  private getStageAsync(): Promise<HTMLElement> {
    const current = this.gameStage$.getValue();
    if (current) {
      return Promise.resolve(current);
    }
    return Promise.race([lastValueFrom(this.gameStage$.pipe(
      filter(x => !!x),
      first(),
      map(x => x as HTMLElement)
    )),
      new Promise((resolve, reject) => {
        setTimeout(() => {
          reject('Cannot add canvas on game stage. Either initDisplay() was never called or your app starts too slow (> 10 seconds)');
        }, 10000);
      })
    ]) as Promise<HTMLElement>;
  }

  async addThreeJsCanvas(zIndex: number, options: Partial<CanvasOptions> | null = null): Promise<ThreeScene> {
    const fullOptions = getFullCanvasOptions(options);
    const canvas = await this.addCanvas(zIndex, 'three');
    const service = await this.createThreeRenderer(fullOptions, canvas, zIndex);
    this.canvases[zIndex].threeSceneService = service;
    return service;
  }

  private async createThreeRenderer(options: CanvasOptions, canvas: HTMLCanvasElement | undefined = undefined, zIndex: number = -Date.now()): Promise<ThreeScene> {
    const scene = new ThreeScene(this.threeRendering, this.viewport, zIndex, canvas as HTMLCanvasElement, options);
    await scene.init();
    return scene;
  }

  private async addCanvas(zIndex: number, type: CanvasType): Promise<HTMLCanvasElement> {
    zIndex = Math.round(zIndex);
    if (this.canvases[zIndex]) {
      throw new Error(`Cannot add canvas on zIndex ${zIndex}. Index is locked by another canvas`);
    }
    const stage = await this.getStageAsync();
    const canvas: HTMLCanvasElement = document.createElement('canvas');
    canvas.style.zIndex = '' + zIndex;
    canvas.id = 'canvas-' + zIndex;
    stage.appendChild(canvas);
    this.canvases[zIndex] = { canvas, type };
    const size = this.viewport.getCurrentViewportSize();
    canvas.width = size.x;
    canvas.height = size.y;
    return canvas;
  }

}
